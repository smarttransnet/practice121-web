/**
 * VoiceCommandService.js
 *
 * Captures a single short "voice command" from the user (e.g. "remove the
 * paracetamol line") and resolves to the transcribed text.
 *
 * Now talks to the dedicated /ws/transcribe-command endpoint instead of the
 * main /ws/transcribe pipeline:
 *   • Server uses an inline en-US chirp_2 recognizer (better accuracy on
 *     short English commands than the si-LK clinical recognizer).
 *   • Server skips Gemini entirely on the command audio — the previous
 *     "wasted Gemini call" is gone, latency drops from ~5-10 s to ~0.5 s.
 *
 * Server message shapes:
 *   Live:  { transcript: string, isFinal: bool, confidence: number }
 *   Final: { transcript: string, isFinal: true, fullCommand: string }
 *
 * Public API (unchanged so ClinicalNoteFullscreen needs no edits):
 *   const session = new VoiceCommandSession({ onInterim, onFinal, onError });
 *   await session.start();
 *   const text = await session.stop();    // resolves to the full command text
 *   session.abort();                      // cancel without waiting
 */

import { AudioCaptureService } from './AudioCaptureService';

const wsUrl = import.meta.env.DEV
  ? 'wss://localhost:44324/ws/transcribe-command'
  : 'wss://note365-stt-api-687271578749.asia-southeast1.run.app/ws/transcribe-command';

// Shorter than the previous full-pipeline timeout because there is no Gemini
// step on this endpoint — the server should respond with `fullCommand` within
// hundreds of ms after STOP.
const FULL_COMMAND_TIMEOUT_MS = 6000;

export class VoiceCommandSession {
  constructor({ onInterim, onFinal, onError } = {}) {
    this.onInterim = onInterim ?? (() => {});
    this.onFinal   = onFinal   ?? (() => {});
    this.onError   = onError   ?? (() => {});

    this.socket = null;
    this.audio  = null;
    this.finals = [];
    this._fullCommandResolve = null;
    this._stopped = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      let opened = false;
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = async () => {
        opened = true;
        try {
          // No JSON config phase on this endpoint — the server starts
          // streaming as soon as the first audio frame arrives.
          this.audio = new AudioCaptureService((buf) => {
            if (this.socket?.readyState === WebSocket.OPEN) {
              this.socket.send(buf);
            }
          });
          await this.audio.start();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      this.socket.onmessage = (evt) => {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }

        // Final summary message: { transcript, isFinal: true, fullCommand }
        if (data.fullCommand !== undefined && data.fullCommand !== null) {
          if (this._fullCommandResolve) {
            this._fullCommandResolve(data.fullCommand);
            this._fullCommandResolve = null;
          }
          return;
        }

        if (data.isFinal) {
          if (data.transcript) this.finals.push(data.transcript);
          this.onFinal(data.transcript, this.finals.join(' '));
        } else {
          this.onInterim(data.transcript || '');
        }
      };

      this.socket.onerror = (e) => {
        if (!opened) {
          reject(new Error('Could not connect to voice-command server.'));
        }
        this.onError(e);
      };

      this.socket.onclose = () => {
        // If we were waiting for fullCommand and the server hung up, fall
        // back to whatever we collected client-side so the caller never hangs.
        if (this._fullCommandResolve) {
          this._fullCommandResolve(this.finals.join(' '));
          this._fullCommandResolve = null;
        }
      };
    });
  }

  // Cleanly stop: silence mic, send STOP, await fullCommand (or timeout),
  // close socket. Returns the best-effort command transcript.
  async stop() {
    if (this._stopped) return this.finals.join(' ');
    this._stopped = true;

    if (this.audio) {
      try { await this.audio.stop(); } catch { /* ignore */ }
      this.audio = null;
    }

    if (!this.socket) return this.finals.join(' ');

    if (this.socket.readyState === WebSocket.OPEN) {
      const fullCommandPromise = new Promise((resolve) => {
        this._fullCommandResolve = resolve;
      });

      try { this.socket.send('STOP'); } catch { /* ignore */ }

      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve(null), FULL_COMMAND_TIMEOUT_MS)
      );

      const result = await Promise.race([fullCommandPromise, timeoutPromise]);

      try { this.socket.close(1000, 'Voice command finished'); } catch { /* ignore */ }
      this.socket = null;
      return (result ?? this.finals.join(' ')).trim();
    }

    try { this.socket.close(); } catch { /* ignore */ }
    this.socket = null;
    return this.finals.join(' ').trim();
  }

  // Force-kill: don't wait for the server response, drop everything.
  // Used when the user cancels mid-recording.
  abort() {
    this._stopped = true;
    if (this.audio) {
      this.audio.stop().catch(() => {});
      this.audio = null;
    }
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        if (
          this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING
        ) {
          this.socket.close(1000, 'Voice command aborted');
        }
      } catch { /* ignore */ }
      this.socket = null;
    }
    if (this._fullCommandResolve) {
      this._fullCommandResolve('');
      this._fullCommandResolve = null;
    }
  }
}
