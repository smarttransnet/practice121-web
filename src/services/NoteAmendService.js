/**
 * NoteAmendService.js
 *
 * Wraps the new POST /notes/amend backend endpoint that accepts an existing
 * clinical note + an amendment command (typed or voice-transcribed) and
 * returns the FULL amended note.
 *
 * Used from ClinicalNoteFullscreen for both the "text edit → save" path
 * (sends the typed text as the "command" with a templated wrapper) and the
 * "voice command" path (sends the transcribed user instruction).
 */

const baseUrl = import.meta.env.DEV
  ? 'https://localhost:44324'
  : 'https://note365-stt-api-687271578749.asia-southeast1.run.app';

export async function amendClinicalNote({ originalNote, command, modelName }) {
  if (!originalNote || !originalNote.trim()) {
    throw new Error('Original note is required.');
  }
  if (!command || !command.trim()) {
    throw new Error('Amendment command is required.');
  }

  const response = await fetch(`${baseUrl}/notes/amend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalNote,
      command,
      modelName: modelName?.trim() || null,
    }),
  });

  if (!response.ok) {
    let message = `Amend request failed (${response.status}).`;
    try {
      const errBody = await response.json();
      if (errBody?.error) message = errBody.error;
      else if (errBody?.detail) message = errBody.detail;
    } catch { /* not JSON, ignore */ }
    throw new Error(message);
  }

  const data = await response.json();
  if (!data?.amendedNote) {
    throw new Error('Server returned an empty amended note.');
  }
  return data.amendedNote;
}
