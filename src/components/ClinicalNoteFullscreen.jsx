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
import { amendClinicalNote, sendClinicalNoteEmail, sendClinicalNoteSms } from '../services/NoteAmendService';
import { VoiceCommandSession } from '../services/VoiceCommandService';
import PrescriptionGrid, { parsePrescriptionRaw, formatItemToSentence, sanitizeToAscii } from './PrescriptionGrid';
import './ClinicalNoteFullscreen.css';

const renderNote = (text) =>
  (text || '').split('\n').map((line, i) => <p key={i}>{line || <br />}</p>);

const extractPrescription = (note) => {
  if (!note) return 'No prescription found.';

  const headerPattern = /\*\*DOCTOR PRESCRIPTION\*\*/i;
  const match = note.match(headerPattern);

  if (!match) {
    // Fallback to just the text without asterisks
    const plainIndex = note.toUpperCase().indexOf('DOCTOR PRESCRIPTION');
    if (plainIndex === -1) return 'No prescription found.';

    const start = plainIndex + 'DOCTOR PRESCRIPTION'.length;
    const nextHeadingIndex = note.indexOf('**', start);
    if (nextHeadingIndex === -1) {
      return note.substring(start).trim();
    } else {
      return note.substring(start, nextHeadingIndex).trim();
    }
  }

  const start = match.index + match[0].length;
  const nextHeadingIndex = note.indexOf('**', start);

  if (nextHeadingIndex === -1) {
    return note.substring(start).trim();
  } else {
    return note.substring(start, nextHeadingIndex).trim();
  }
};

const ClinicalNoteFullscreen = ({ originalNote, modelName, activePatient, onClose, onAccept, onFinishConsultation }) => {
  const [mode, setMode] = useState('view');
  const [activeTab, setActiveTab] = useState('notes'); // 'notes' | 'prescription'
  const [editedText, setEditedText] = useState(originalNote);
  const [amendedNote, setAmendedNote] = useState('');
  const [voiceCommand, setVoiceCommand] = useState('');
  const [interim, setInterim] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isSendingSms, setIsSendingSms] = useState(false);
  const [smsMsg, setSmsMsg] = useState(null);

  const sessionRef = useRef(null);

  const handleSendSmsPrescription = async () => {
    const rawPrescription = extractPrescription(editedText || originalNote);
    const parsedItems = parsePrescriptionRaw(rawPrescription);
    const asciiPrescription = parsedItems.map(formatItemToSentence).filter(Boolean).map(sanitizeToAscii).join('\n') || sanitizeToAscii(rawPrescription);
    const targetMobile = activePatient?.patientMobile || '0775706080';
    setIsSendingSms(true);
    setSmsMsg(null);
    setError(null);
    try {
      await sendClinicalNoteSms({
        mobileNumber: targetMobile,
        body: `Prescription:\n${asciiPrescription}\n\nThank you,\nPractice121\n`
      });
      setSmsMsg(`Prescription SMS sent to ${targetMobile}`);
    } catch (err) {
      setError(err.message || 'Failed to send SMS');
    } finally {
      setIsSendingSms(false);
    }
  };

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

  useEffect(() => {
    setEditedText(originalNote);
    setAmendedNote('');
    setVoiceCommand('');
    setInterim('');
    setAudioUrl(null);
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
      const result = await sessionRef.current.stop();
      const command = result?.fullCommand || voiceCommand;
      const url = result?.audioUrl;
      sessionRef.current = null;

      if (!command || !command.trim()) {
        setError('No voice command captured. Please try again.');
        setIsProcessing(false);
        setMode('view');
        return;
      }

      setVoiceCommand(command);
      setAudioUrl(url);
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
  const handleAccept = async () => {
    if (audioUrl) {
      try {
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const timestamp = `${day}/${month}/${year} ${hour}:${minute}`;

        const prescription = extractPrescription(amendedNote);
        const emailBody = `- Original Note -\n${originalNote}\n\n- Amendments -\n${voiceCommand}\n\n- Prescription -\n${prescription}\n\n- Session -\n${audioUrl}`;

        await sendClinicalNoteEmail({
          toEmail: 'mihipal@gmail.com',
          subject: `Edited Recording - Session and ${timestamp}`,
          body: emailBody,
        });
      } catch (err) {
        console.error('Failed to send edited recording email:', err);
      }
    }
    onAccept(amendedNote);
  };

  const handleReject = () => {
    setAmendedNote('');
    setVoiceCommand('');
    setInterim('');
    setAudioUrl(null);
    setEditedText(originalNote);
    setMode('view');
  };

  // ─── Header label per mode ──────────────────────────────────────────────
  const modeLabel =
    mode === 'edit-text' ? 'Text Edit'
      : mode === 'voice-amend' ? (isRecording ? 'Voice Amend — Recording' : isProcessing ? 'Voice Amend — Amending…' : 'Voice Amend')
        : mode === 'compare' ? 'Review Amendment'
          : 'Clinical Note';

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
              <div className="cn-tabs">
                <button
                  className={`cn-tab-btn ${activeTab === 'notes' ? 'active' : ''}`}
                  onClick={() => setActiveTab('notes')}
                >
                  NOTES
                </button>
                <button
                  className={`cn-tab-btn ${activeTab === 'prescription' ? 'active' : ''}`}
                  onClick={() => setActiveTab('prescription')}
                >
                  PRESCRIPTION
                </button>
              </div>

              <div className="cn-fs-note scrollbar-styled">
                {activeTab === 'notes' ? (
                  renderNote(originalNote)
                ) : (
                  <PrescriptionGrid
                    initialRawPrescription={extractPrescription(originalNote)}
                  />
                )}
              </div>
              {smsMsg && (
                <div style={{ margin: '8px 0', padding: '10px 14px', background: '#dcfce7', color: '#15803d', borderRadius: '8px', fontSize: '0.9rem', fontWeight: 'bold' }}>
                  ✓ {smsMsg}
                </div>
              )}
              <div className="cn-fs-actions" style={{ flexWrap: 'wrap', gap: '8px' }}>
                <button className="cn-btn cn-btn-secondary" onClick={handleStartTextEdit}>
                  ✎ Text Edit
                </button>
                <button className="cn-btn cn-btn-primary" onClick={handleStartVoice}>
                  🎙 Voice Command
                </button>
                <button className="cn-btn cn-btn-secondary" onClick={handleSendSmsPrescription} disabled={isSendingSms}>
                  {isSendingSms ? 'Sending SMS...' : '📱 Send SMS Prescription'}
                </button>
                {onFinishConsultation && (
                  <button className="cn-btn" style={{ background: '#22c55e', color: '#fff', fontWeight: 'bold' }} onClick={onFinishConsultation}>
                    ✓ Finish Consultation
                  </button>
                )}
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
