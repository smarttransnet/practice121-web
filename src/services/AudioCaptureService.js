/**
 * AudioCaptureService.js
 *
 * Captures microphone audio and delivers 100 ms PCM-16 chunks to the caller.
 *
 * The AudioWorklet processor is injected as a Blob URL — no file-system path,
 * no CDN lookup, no CORS concern.  This is critical because the Vite config
 * sets a non-root `base` URL (a GCS bucket), which means any absolute path
 * like '/pcm-processor.js' resolves against the CDN and 404s in dev.
 *
 * Fallback: if AudioWorklet is unavailable (old Safari / Android WebView) the
 * service falls back to the deprecated ScriptProcessorNode automatically.
 */

// ── Worklet source (inlined as a string, injected via Blob URL) ─────────────
// Accumulates raw Float32 samples in a dedicated audio-worklet thread and
// ships exactly 100 ms = 1600 samples @ 16 kHz as an Int16 ArrayBuffer via
// zero-copy postMessage transfer.  Running in the worklet thread means the
// main thread's React renders / WebSocket callbacks can never cause dropped
// audio frames — the root cause of "missing words" with ScriptProcessorNode.
const PCM_PROCESSOR_SRC = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetMs      = 100;
    this._sampleRate    = sampleRate;
    this._targetSamples = Math.round(this._sampleRate * this._targetMs / 1000);
    this._buf           = new Float32Array(this._targetSamples);
    this._filled        = 0;
    // Level diagnostics — track RMS over a 1-second window so we can tell
    // whether the mic is producing signal or silence.
    this._levelSumSq    = 0;
    this._levelSamples  = 0;
    this._levelWindow   = this._sampleRate; // 1 s
    this._chunksSent    = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    // Accumulate for the RMS window (cheap — one multiply-add per sample).
    for (let i = 0; i < channel.length; i++) {
      const s = channel[i];
      this._levelSumSq   += s * s;
      this._levelSamples += 1;
    }
    if (this._levelSamples >= this._levelWindow) {
      const rms  = Math.sqrt(this._levelSumSq / this._levelSamples);
      const dbfs = 20 * Math.log10(rms || 1e-9);
      this.port.postMessage({ type: 'level', rms, dbfs, chunks: this._chunksSent });
      this._levelSumSq   = 0;
      this._levelSamples = 0;
    }

    let srcOffset = 0;
    while (srcOffset < channel.length) {
      const space  = this._targetSamples - this._filled;
      const toCopy = Math.min(space, channel.length - srcOffset);
      this._buf.set(channel.subarray(srcOffset, srcOffset + toCopy), this._filled);
      this._filled  += toCopy;
      srcOffset     += toCopy;

      if (this._filled === this._targetSamples) {
        const pcm16 = new Int16Array(this._targetSamples);
        for (let i = 0; i < this._targetSamples; i++) {
          const s = Math.max(-1, Math.min(1, this._buf[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this._chunksSent++;
        this.port.postMessage({ type: 'pcm', buffer: pcm16.buffer }, [pcm16.buffer]);
        this._filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

export class AudioCaptureService {
  constructor(onAudioData) {
    this.onAudioData   = onAudioData;
    this.audioContext  = null;
    this.stream        = null;
    this.source        = null;
    this.analyser      = null;
    this._workletNode  = null;
    this._scriptNode   = null;
    this._blobUrl      = null; // tracked so we can revoke it on stop()
  }

  async start() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:   16000,
      latencyHint: 'interactive',
    });

    // Chrome can auto-suspend a new AudioContext before any audio is connected.
    // Always resume so the worklet/processor thread is running from the start.
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three processors ON — this was the working baseline that gave
        // ~90% capture rate. Turning noiseSuppression OFF (to send "raw" audio
        // to Google) empirically made capture WORSE in our clinic environment,
        // likely because continuous background noise confuses Google's VAD
        // when it tries to emit SPEECH_ACTIVITY events.
        echoCancellation:  true,
        noiseSuppression:  true,
        autoGainControl:   true,
        channelCount:      1,
        sampleRate:        16000,
      },
    });

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.source.connect(this.analyser);

    if (typeof AudioWorkletNode !== 'undefined') {
      await this._startWorklet();
    } else {
      console.warn('[AudioCaptureService] AudioWorklet unavailable — falling back to ScriptProcessorNode');
      this._startScriptProcessor();
    }

    console.log(
      '[AudioCaptureService] started via',
      this._workletNode ? 'AudioWorklet' : 'ScriptProcessorNode',
      `| context sampleRate: ${this.audioContext.sampleRate} Hz`,
      `| context state: ${this.audioContext.state}`
    );
  }

  // ── AudioWorklet (preferred) ───────────────────────────────────────────────

  async _startWorklet() {
    // Inject the processor source as a Blob URL.
    // This avoids ALL path/CORS/base-URL issues — the code is self-contained
    // and never fetched from the network.
    try {
      this._blobUrl = URL.createObjectURL(
        new Blob([PCM_PROCESSOR_SRC], { type: 'application/javascript' })
      );
      await this.audioContext.audioWorklet.addModule(this._blobUrl);
    } catch (err) {
      console.warn('[AudioCaptureService] AudioWorklet failed, using ScriptProcessorNode fallback:', err);
      this._revokeBlob();
      this._startScriptProcessor();
      return;
    }

    this._workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
    this._workletNode.port.onmessage = (evt) => {
      const msg = evt.data;
      if (msg && msg.type === 'pcm') {
        this.onAudioData(msg.buffer);
      } else if (msg && msg.type === 'level') {
        // Level report every 1 s — key diagnostic for "no transcript" issues.
        // dBFS is log-scale: 0 = full scale, -60 = whisper, -∞ = pure silence.
        // If dBFS is below ~-55 during speech, the mic is effectively silent.
        const marker = msg.dbfs < -55 ? ' ⚠ SILENCE'
                     : msg.dbfs < -40 ? ' (quiet)'
                     : msg.dbfs < -20 ? ' (normal)'
                     :                   ' (loud)';
        console.log(
          '%c[audio-level]',
          'color:#10b981;font-weight:bold',
          `rms=${msg.rms.toFixed(4)}  dBFS=${msg.dbfs.toFixed(1)}${marker}  chunksSent=${msg.chunks}`
        );
      }
    };
    this.source.connect(this._workletNode);
  }

  // ── ScriptProcessorNode (fallback) ────────────────────────────────────────

  _startScriptProcessor() {
    // 4096 samples @ 16 kHz = 256 ms. The server splits to ≤100 ms on its side.
    this._scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this._scriptNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.onAudioData(pcm16.buffer);
    };
    this.source.connect(this._scriptNode);
    this._scriptNode.connect(this.audioContext.destination);
  }

  // ── Visualizer ─────────────────────────────────────────────────────────────

  getByteFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  _revokeBlob() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  // Returns a Promise so callers can await full teardown before starting a
  // new session.  Not awaiting this was the root cause of "3rd session gives
  // only 1-2 words": the old AudioContext was still closing while the new one
  // was already created, causing Chrome's internal resampler to get confused.
  async stop() {
    // 1. Silence the worklet/script node first so no stale audio chunks fire
    //    onAudioData callbacks after we start tearing down.
    if (this._workletNode) {
      this._workletNode.port.onmessage = null;
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._scriptNode) {
      this._scriptNode.onaudioprocess = null;
      this._scriptNode.disconnect();
      this._scriptNode = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    // 2. Release the microphone hardware track BEFORE closing the AudioContext.
    //    This is the correct teardown order: stop the input source first, then
    //    shut down the processing pipeline.
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    // 3. Await the AudioContext close so Chrome fully releases the resampler
    //    and audio thread before the next session creates a new context.
    if (this.audioContext) {
      try { await this.audioContext.close(); } catch { /* already closed */ }
      this.audioContext = null;
    }

    this._revokeBlob();
    console.log('[AudioCaptureService] stopped');
  }
}
