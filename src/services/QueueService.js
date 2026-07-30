/**
 * QueueService.js
 *
 * Wraps the POST /api/v1/queue/next-patient endpoint to trigger
 * patient queue progression from the AI Services consultation workspace.
 */

const baseUrl = import.meta.env.DEV
  ? 'https://localhost:44324'
  : 'https://note365-stt-api-687271578749.asia-southeast1.run.app';

export async function advanceNextPatient({ doctorId, practiceCentreId, visitDate } = {}) {
  if (!doctorId) {
    throw new Error('Doctor ID is required for queue progression.');
  }

  const response = await fetch(`${baseUrl}/api/v1/queue/next-patient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doctorId,
      practiceCentreId: practiceCentreId || null,
      visitDate: visitDate || null,
    }),
  });

  if (!response.ok) {
    let message = `Queue transition failed (${response.status}).`;
    try {
      const errBody = await response.json();
      if (errBody?.error) message = errBody.error;
      else if (errBody?.detail) message = errBody.detail;
    } catch { /* ignore non-json */ }
    throw new Error(message);
  }

  return await response.json();
}
