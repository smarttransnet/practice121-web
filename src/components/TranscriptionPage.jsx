import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCaptureService } from '../services/AudioCaptureService';
import ClinicalNoteFullscreen from './ClinicalNoteFullscreen';
import './TranscriptionPage.css';

// Pre-loading modern typography for a next-gen feel
const FONT_URL = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap";
const link = document.createElement('link');
link.href = FONT_URL;
link.rel = 'stylesheet';
document.head.appendChild(link);

const TranscriptionPage = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscripts, setFinalTranscripts] = useState([]);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [modelName, setModelName] = useState('');
  const [processedResponse, setProcessedResponse] = useState('');
  const [fullTranscript, setFullTranscript] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [visualizerData, setVisualizerData] = useState(new Array(20).fill(20));

  const socketRef = useRef(null);
  const audioServiceRef = useRef(null);
  const animationFrameRef = useRef(null);
  const smoothedVisualizerRef = useRef(new Array(20).fill(12));
  const retryCount    = useRef(0);
  const maxRetries    = 3;
  const isRetryingRef = useRef(false); // true while a retry setTimeout is pending
  const retryTimerRef = useRef(null);  // timer ID so we can cancel on manual stop

  // Animate waveform
  const updateVisualizer = () => {
    if (audioServiceRef.current && isRecording) {
      const freqData = audioServiceRef.current.getByteFrequencyData();
      if (freqData.length > 0) {
        // Sample 20 bars from analyser output and smooth to avoid jitter.
        const barCount = 20;
        const step = Math.max(1, Math.floor(freqData.length / barCount));
        const newData = [];
        for (let i = 0; i < barCount; i++) {
          const val = freqData[i * step] || 0;
          // Keep motion visible even for lower voice levels.
          const normalized = 10 + (val / 255) * 90;
          const prev = smoothedVisualizerRef.current[i] ?? 10;
          const smoothed = prev * 0.65 + normalized * 0.35;
          smoothedVisualizerRef.current[i] = smoothed;
          newData.push(Math.min(100, Math.max(10, smoothed)));
        }
        setVisualizerData(newData);
      }
    } else {
      const idleData = new Array(20).fill(10);
      smoothedVisualizerRef.current = idleData;
      setVisualizerData(idleData);
    }
    animationFrameRef.current = requestAnimationFrame(updateVisualizer);
  };

  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(updateVisualizer);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [isRecording]);

  const [isTrayOpen, setIsTrayOpen] = useState(false);
  const [isNoteReady, setIsNoteReady] = useState(false);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

  // Auto-expand tray AND auto-open the full-screen view when note is ready.
  // Tracks the last note we auto-opened for so a re-render doesn't re-open
  // a fullscreen the user has explicitly closed.
  const lastAutoOpenedNoteRef = useRef(null);
  useEffect(() => {
    if (processedResponse && !isTrayOpen) {
      setIsTrayOpen(true);
      setIsNoteReady(true);
    }
    if (processedResponse && lastAutoOpenedNoteRef.current !== processedResponse) {
      lastAutoOpenedNoteRef.current = processedResponse;
      setIsFullscreenOpen(true);
    }
  }, [processedResponse]);

  // The full-screen view's "Accept Amendment" callback — replace the note
  // in place so subsequent edits/voice commands chain off the new version.
  const handleAcceptAmendment = useCallback((amendedNote) => {
    setProcessedResponse(amendedNote);
    lastAutoOpenedNoteRef.current = amendedNote; // don't re-auto-open
    setIsFullscreenOpen(false);
  }, []);

  // isRetry=true when called automatically from onerror.
  // CRITICAL: never reset retryCount inside a retry call — that was the bug
  // that caused the infinite start/stop loop (counter reset to 0 on every
  // attempt, limit never reached, audio kept cycling endlessly).
  const startStreaming = useCallback(async (isRetry = false) => {
    isRetryingRef.current = false; // pending timer has fired

    try {
      // ── Dispose any lingering prior session ───────────────────────────────
      if (socketRef.current) {
        try {
          socketRef.current.onopen    = null;
          socketRef.current.onmessage = null;
          socketRef.current.onerror   = null;
          socketRef.current.onclose   = null;
          if (
            socketRef.current.readyState === WebSocket.OPEN ||
            socketRef.current.readyState === WebSocket.CONNECTING
          ) {
            socketRef.current.close(1000, 'New session starting');
          }
        } catch { /* ignore */ }
        socketRef.current = null;
      }
      if (audioServiceRef.current) {
        // MUST await: stop() is now async and awaits audioContext.close().
        // Without await, the old AudioContext stays "closing" while the new
        // one is created — after 2 sessions this causes Chrome's resampler to
        // behave erratically and the 3rd session only captures 1-2 words.
        try { await audioServiceRef.current.stop(); } catch { /* ignore */ }
        audioServiceRef.current = null;
      }

      // Only wipe UI state and reset the counter on a genuine user-initiated
      // start. Retries preserve state so the user sees what was transcribed.
      if (!isRetry) {
        retryCount.current = 0;
        setFinalTranscripts([]);
        setInterimTranscript('');
        setProcessedResponse('');
        setFullTranscript('');
        setIsNoteReady(false);
        setIsProcessing(false);
      }

      setError(null);
      setStatus(isRetry ? `Reconnecting (${retryCount.current}/${maxRetries})…` : 'Connecting…');

      // const wsUrl = import.meta.env.DEV
      //   ? 'wss://localhost:44324/ws/transcribe'
      //   : 'wss://note365-stt-api-687271578749.asia-southeast1.run.app/ws/transcribe';

        const wsUrl = import.meta.env.DEV
        ? 'wss://note365-stt-api-687271578749.asia-southeast1.run.app/ws/transcribe'
        : 'wss://note365-stt-api-687271578749.asia-southeast1.run.app/ws/transcribe';

      socketRef.current = new WebSocket(wsUrl);

      socketRef.current.onopen = () => {
        setStatus('Streaming');
        setIsRecording(true);
        retryCount.current = 0;
        const trimmedPrompt = customPrompt.trim();
        const trimmedModel = modelName.trim();
        const config = {
          ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
          ...(trimmedModel ? { model: trimmedModel } : {}),
        };
        socketRef.current.send(JSON.stringify(config));
      };

      socketRef.current.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // Check for processedNote with a more robust null/undefined check
        if (data.processedNote !== undefined && data.processedNote !== null) {
          console.log('%c[note]', 'color:#a855f7;font-weight:bold',
            data.processedNote.length, 'chars');
          if (data.fullTranscript) {
            console.log(
              '%c[full-transcript]',
              'color:#f59e0b;font-weight:bold',
              `${data.fullTranscript.length} chars\n` + data.fullTranscript
            );
            setFullTranscript(data.fullTranscript);
          }
          setProcessedResponse(data.processedNote);
          setIsProcessing(false);
          setIsTrayOpen(true); // Ensure tray expands immediately
          setStatus('Ready');
          return;
        }
        if (data.isFinal) {
          console.log(
            '%c[final]',
            'color:#22c55e;font-weight:bold',
            data.speakerLabel ? `[${data.speakerLabel}]` : '',
            `conf=${(data.confidence ?? 0).toFixed(2)}`,
            data.transcript
          );

          const entry = {
            text: data.transcript,
            speakerLabel: data.speakerLabel || '',
            time: new Date().toLocaleTimeString(),
          };
          setFinalTranscripts(prev => [...prev, entry]);
          setInterimTranscript('');
        } else {
          // Log every interim so you can see the real-time cadence in the
          // browser Console without needing to enable "Verbose" log level.
          console.log(
            '%c[interim]',
            'color:#06b6d4',
            data.transcript
          );
          setInterimTranscript(data.transcript);
        }
      };

      socketRef.current.onerror = () => {
        if (retryCount.current < maxRetries) {
          retryCount.current++;
          const delaySec = retryCount.current * 2; // 2 s, 4 s, 6 s back-off
          console.warn(`[WS] error — retry ${retryCount.current}/${maxRetries} in ${delaySec}s`);
          isRetryingRef.current = true;
          retryTimerRef.current = setTimeout(() => startStreaming(true), delaySec * 1000);
        } else {
          console.error('[WS] max retries exhausted');
          setError(`Could not connect after ${maxRetries} attempts. Is the server running?`);
          stopStreaming();
        }
      };

      socketRef.current.onclose = () => {
        // Don't flash "Ready" between retries — only update when we truly stop.
        if (!isRetryingRef.current) {
          setStatus('Ready');
          setIsRecording(false);
        }
      };

      audioServiceRef.current = new AudioCaptureService((audioBuffer) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(audioBuffer);
        }
      });
      await audioServiceRef.current.start();
    } catch (err) {
      setError('Could not access microphone.');
      setStatus('Error');
    }
  }, [customPrompt, modelName]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close(1000, "Component unmounted");
        socketRef.current = null;
      }
      if (audioServiceRef.current) {
        audioServiceRef.current.stop().catch(() => {});
        audioServiceRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const stopStreaming = useCallback(() => {
    if (audioServiceRef.current) {
      // stop() is async (awaits audioContext.close) but we can't await here
      // since stopStreaming is synchronous.  The nodes are silenced immediately
      // inside stop() before any async work, so no stale audio chunks fire.
      audioServiceRef.current.stop().catch(() => {});
      audioServiceRef.current = null;
    }

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send("STOP");
      setIsProcessing(true);
      setStatus('Processing...');
      // NOTE: Do NOT clear interimTranscript here. The server synthesizes a
      // FINAL for any trailing interim after STOP — keeping the current
      // interim visible lets that final replace it cleanly instead of the
      // user watching their last words vanish for ~1 s.
    } else {
      socketRef.current?.close(1000);
      socketRef.current = null;
      setIsRecording(false);
      setStatus('Ready');
      setInterimTranscript('');
    }
  }, []);

  const handleToggle = () => {
    // Block restart while Gemini is still generating the note for the previous
    // session — otherwise the new WebSocket races with the old one's finally
    // block and the UI state would briefly show both a note and a live stream.
    if (isProcessing) return;
    if (isRecording) {
      // Cancel any pending retry timer so a manual Stop is always final.
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      isRetryingRef.current = false;
      stopStreaming();
    } else {
      startStreaming(false); // explicit false = user-initiated, reset retryCount
    }
  };

  const downloadProcessedNote = () => {
    if (!processedResponse) return;
    const text = "Note365 Processed Clinical Note\n" +
      "Generated on: " + new Date().toLocaleString() + "\n" +
      "------------------------------------------\n\n" +
      processedResponse;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Note365_Note_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="transcription-container">
      <header className="app-header">
        <div className="logo">
          <h1>Note365</h1>
        </div>
        <div className="header-status">
          <div className={`recording-status-modern ${isRecording ? 'active' : ''}`}>
            {isRecording ? 'LIVE SESSION' : isProcessing ? 'GENERATING...' : 'STANDBY'}
          </div>
        </div>
      </header>

      <main className="voice-hub-section">
        <div className={`main-layout ${isTrayOpen ? 'tray-open' : 'tray-closed'}`}>

          {/* Left: Collapsible Note Tray */}
          <section className="note-tray">
            <button className="tray-toggle" onClick={() => {
              setIsTrayOpen(!isTrayOpen);
              if (!isTrayOpen) setIsNoteReady(false);
            }}>
              <span className="toggle-icon">{isTrayOpen ? '◀' : '▶'}</span>
              {!isTrayOpen && <span className="vertical-label">CLINICAL NOTES</span>}
              {isTrayOpen && <span className="horizontal-label">Close Tray</span>}
              {!isTrayOpen && isNoteReady && <span className="ready-badge" />}
            </button>

            <div className="tray-content">
              {processedResponse ? (
                <>
                  <div className="tray-header">
                    <h3>Processed Clinical Note</h3>
                    <div className="tray-header-actions">
                      <button
                        className="fullscreen-btn-mini"
                        onClick={() => setIsFullscreenOpen(true)}
                        title="Open in full-screen view to amend"
                      >
                        ⛶ Open / Amend
                      </button>
                      <button className="download-btn-mini" onClick={downloadProcessedNote}>
                        Download Note
                      </button>
                    </div>
                  </div>
                  <div className="note-display scrollbar-styled">
                    {processedResponse.split('\n').map((line, i) => (
                      <p key={i}>{line || <br />}</p>
                    ))}
                  </div>

                  {/* Full Conversation (Raw) panel intentionally hidden */}
                </>
              ) : (
                <div className="tray-empty">
                  {isProcessing ? (
                    <div className="ai-status-container">
                      <div className="shimmer-loader"></div>
                      <p>AI is crafting your clinical note...</p>
                    </div>
                  ) : (
                    <p>Clinical notes will appear here <br /> after you finish your session.</p>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Center: Controls */}
          <section className="controls-panel">
            <div className="visualizer-container">
              {visualizerData.map((h, i) => (
                <div key={i} className="vis-bar" style={{ '--level': `${h / 100}` }} />
              ))}
            </div>

            <div className={`mic-hub-modern ${isRecording ? 'active' : ''}`} onClick={handleToggle}>
              <div className="mic-aura"></div>
              <button className={`mic-main-btn ${isRecording ? 'stop' : 'start'}`} disabled={isProcessing}>
                {isRecording ? '■' : '🎤'}
              </button>
            </div>

            {/* Live transcript panel intentionally hidden */}

            {isProcessing && (
              <div className="ai-crafting-experience">
                <div className="sparkle">✨</div>
                <p className="glow-text">AI is crafting your clinical note...</p>
                <div className="progress-glimmer"></div>
              </div>
            )}

            <button className="config-trigger" onClick={() => setIsConfigOpen(true)}>
              Configure prompt
            </button>
          </section>
        </div>
      </main>

      {/* Collapsible Sidebar */}
      <div className={`config-sidebar ${isConfigOpen ? 'open' : ''}`}>
        <button className="sidebar-close" onClick={() => setIsConfigOpen(false)}>✕</button>
        <div className="form-group">
          <label>Custom Prompt</label>
          <textarea
            placeholder="e.g. Format as a SOAP note"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            className="sidebar-textarea"
            rows={6}
          />
        </div>
        {/* Removed 'Don't type anything' input as requested */}
      </div>

      {error && (
        <div className="error-toast">
          ⚠️ {error} <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {isFullscreenOpen && processedResponse && (
        <ClinicalNoteFullscreen
          originalNote={processedResponse}
          modelName={modelName}
          onClose={() => setIsFullscreenOpen(false)}
          onAccept={handleAcceptAmendment}
        />
      )}
    </div>
  );
};

export default TranscriptionPage;
