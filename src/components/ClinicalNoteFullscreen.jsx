/**
 * ClinicalNoteFullscreen.jsx
 *
 * Full-screen view of the generated clinical note with two amendment paths:
 *
 *   1. TEXT EDIT      — direct textarea editing, Save & Confirm.
 *   2. VOICE COMMAND  — record a short instruction; backend amends the note
 *                       via Gemini using the new /notes/amend endpoint.
 *
 * After either path produces a candidate "amended" version, the user sees
 * a side-by-side ORIGINAL vs AMENDED comparison and chooses Accept or Reject.
 * Accept commits the change back to the parent (TranscriptionPage) and closes
 * the overlay; Reject discards and returns to the read-only view.
 *
 * Modes: 'view' | 'edit-text' | 'voice-amend' | 'compare'
 */

import { useState, useRef, useEffect } from 'react';
import { amendClinicalNote } from '../services/NoteAmendService';
import { VoiceCommandSession } from '../services/VoiceCommandService';
import './ClinicalNoteFullscreen.css';

const renderNote = (text) =>
  (text || '').split('\n').map((line, i) => <p key={i}>{line || <br />}</p>);

const ClinicalNoteFullscreen = ({ originalNote, modelName, onClose, onAccept }) => {
  const [mode, setMode] = useState('view');
  const [editedText, setEditedText] = useState(originalNote);
  const [amendedNote, setAmendedNote] = useState('');
  const [voiceCommand, setVoiceCommand] = useState('');
  const [interim, setInterim] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);

  const sessionRef = useRef(null);

  // Lock background scroll while the overlay is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Make sure any active mic session is killed if the component unmounts
  // (e.g. parent closes the overlay or starts a new recording session).
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.abort();
        sessionRef.current = null;
      }
    };
  }, []);

  // Keep editedText in sync if a brand-new note is loaded into the overlay.
  useEffect(() => {
    setEditedText(originalNote);
    setAmendedNote('');
    setVoiceCommand('');
    setInterim('');
    setMode('view');
  }, [originalNote]);

  // ─── Text edit ──────────────────────────────────────────────────────────
  const handleStartTextEdit = () => {
    setError(null);
    setEditedText(originalNote);
    setMode('edit-text');
  };

  const handleSaveTextEdit = () => {
    if (!editedText || !editedText.trim()) {
      setError('Note cannot be empty.');
      return;
    }
    setAmendedNote(editedText);
    setMode('compare');
  };

  // ─── Voice amend ────────────────────────────────────────────────────────
  const handleStartVoice = async () => {
    setError(null);
    setVoiceCommand('');
    setInterim('');
    setMode('voice-amend');

    sessionRef.current = new VoiceCommandSession({
      onInterim: (text) => setInterim(text),
      onFinal: (_t, full) => { setVoiceCommand(full); setInterim(''); },
      onError: () => setError('Microphone or connection error during recording.'),
    });

    try {
      await sessionRef.current.start();
      setIsRecording(true);
    } catch (err) {
      setError(`Could not start recording: ${err.message || err}`);
      sessionRef.current = null;
      setMode('view');
    }
  };

  const handleStopVoiceAndApply = async () => {
    if (!sessionRef.current) return;
    setIsRecording(false);
    setIsProcessing(true);
    try {
      const command = (await sessionRef.current.stop()) || voiceCommand;
      sessionRef.current = null;

      if (!command || !command.trim()) {
        setError('No voice command captured. Please try again.');
        setIsProcessing(false);
        setMode('view');
        return;
      }

      setVoiceCommand(command);
      const amended = await amendClinicalNote({
        originalNote,
        command,
        modelName,
      });
      setAmendedNote(amended);
      setMode('compare');
    } catch (err) {
      setError(`Amendment failed: ${err.message || err}`);
      setMode('view');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelVoice = () => {
    if (sessionRef.current) {
      sessionRef.current.abort();
      sessionRef.current = null;
    }
    setIsRecording(false);
    setIsProcessing(false);
    setVoiceCommand('');
    setInterim('');
    setMode('view');
  };

  // ─── Compare ────────────────────────────────────────────────────────────
  const handleAccept = () => {
    onAccept(amendedNote);
  };

  const handleReject = () => {
    setAmendedNote('');
    setVoiceCommand('');
    setInterim('');
    setEditedText(originalNote);
    setMode('view');
  };

  // ─── Header label per mode ──────────────────────────────────────────────
  const modeLabel =
    mode === 'edit-text'    ? 'Text Edit'
    : mode === 'voice-amend' ? (isRecording ? 'Voice Amend — Recording' : isProcessing ? 'Voice Amend — Amending…' : 'Voice Amend')
    : mode === 'compare'     ? 'Review Amendment'
    :                          'Clinical Note';

  return (
    <div className="cn-fs-backdrop" role="dialog" aria-modal="true" aria-label="Clinical note full screen">
      <div className="cn-fs-shell">

        <header className="cn-fs-header">
          <div className="cn-fs-title">
            <span className="cn-fs-eyebrow">Note365</span>
            <h2>{modeLabel}</h2>
          </div>
          <button className="cn-fs-close" onClick={onClose} aria-label="Close full screen">✕</button>
        </header>

        <div className="cn-fs-body">
          {/* ── VIEW ──────────────────────────────────────────────────── */}
          {mode === 'view' && (
            <>
              <div className="cn-fs-note scrollbar-styled">
                {renderNote(originalNote)}
              </div>
              <div className="cn-fs-actions">
                <button className="cn-btn cn-btn-secondary" onClick={handleStartTextEdit}>
                  ✎ Text Edit
                </button>
                <button className="cn-btn cn-btn-primary" onClick={handleStartVoice}>
                  🎙 Voice Command
                </button>
              </div>
            </>
          )}

          {/* ── TEXT EDIT ─────────────────────────────────────────────── */}
          {mode === 'edit-text' && (
            <>
              <textarea
                className="cn-fs-textarea scrollbar-styled"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                spellCheck={true}
                aria-label="Edit clinical note"
              />
              <div className="cn-fs-actions">
                <button className="cn-btn cn-btn-ghost" onClick={() => { setMode('view'); setEditedText(originalNote); }}>
                  Cancel
                </button>
                <button className="cn-btn cn-btn-primary" onClick={handleSaveTextEdit}>
                  Confirm & Review
                </button>
              </div>
            </>
          )}

          {/* ── VOICE AMEND ───────────────────────────────────────────── */}
          {mode === 'voice-amend' && (
            <>
              <div className="cn-fs-voice-panel">
                <div className={`cn-voice-orb ${isRecording ? 'recording' : ''} ${isProcessing ? 'processing' : ''}`}>
                  <button
                    className="cn-voice-mic-btn"
                    onClick={isRecording ? handleStopVoiceAndApply : (isProcessing ? undefined : handleStartVoice)}
                    disabled={isProcessing}
                    aria-label={isRecording ? 'Stop recording and apply' : 'Start recording'}
                  >
                    {isProcessing ? '⋯' : isRecording ? '■' : '🎙'}
                  </button>
                </div>
                <p className="cn-voice-hint">
                  {isProcessing
                    ? 'Amending note with Gemini…'
                    : isRecording
                      ? 'Speak your amendment, then click ■ to apply.'
                      : 'Click the mic to record an amendment instruction.'}
                </p>

                <div className="cn-voice-transcript scrollbar-styled" aria-live="polite">
                  <div className="cn-voice-final">{voiceCommand}</div>
                  <div className="cn-voice-interim">{interim}</div>
                  {!voiceCommand && !interim && !isRecording && !isProcessing && (
                    <div className="cn-voice-placeholder">
                      e.g. "Remove the paracetamol line", "Add allergy to penicillin in Subjective", "Change BP to 130 over 80"
                    </div>
                  )}
                </div>
              </div>
              <div className="cn-fs-actions">
                <button className="cn-btn cn-btn-ghost" onClick={handleCancelVoice} disabled={isProcessing}>
                  Cancel
                </button>
                {isRecording && (
                  <button className="cn-btn cn-btn-primary" onClick={handleStopVoiceAndApply}>
                    Stop & Apply
                  </button>
                )}
              </div>
            </>
          )}

          {/* ── COMPARE ───────────────────────────────────────────────── */}
          {mode === 'compare' && (
            <>
              <div className="cn-compare-grid">
                <div className="cn-compare-pane">
                  <div className="cn-compare-pane-header original">Original</div>
                  <div className="cn-compare-pane-body scrollbar-styled">
                    {renderNote(originalNote)}
                  </div>
                </div>
                <div className="cn-compare-pane">
                  <div className="cn-compare-pane-header amended">Amended</div>
                  <div className="cn-compare-pane-body scrollbar-styled">
                    {renderNote(amendedNote)}
                  </div>
                </div>
              </div>
              {voiceCommand && (
                <div className="cn-compare-command">
                  <span className="cn-compare-command-label">Voice command:</span>
                  <span className="cn-compare-command-text">{voiceCommand}</span>
                </div>
              )}
              <div className="cn-fs-actions">
                <button className="cn-btn cn-btn-ghost" onClick={handleReject}>
                  Reject
                </button>
                <button className="cn-btn cn-btn-primary" onClick={handleAccept}>
                  Accept Amendment
                </button>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="cn-fs-error" role="alert">
            ⚠ {error}
            <button onClick={() => setError(null)} aria-label="Dismiss error">✕</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ClinicalNoteFullscreen;
