export async function withEphemeralAudio(audio, operation) {
  if (!Buffer.isBuffer(audio)) return operation(audio)
  try { return await operation(audio) } finally { audio.fill(0) }
}
// Synthesized audio is returned to the caller in memory only. Callers that are
// done with the bytes must release them; this zeroes the buffer and drops the
// reference on success, error, timeout and abort alike.
export function releaseSynthesizedAudio(result) {
  const bytes = result?.audio?.bytes
  if (Buffer.isBuffer(bytes)) bytes.fill(0)
  if (result?.audio && 'bytes' in result.audio) result.audio.bytes = null
  return result
}
export async function withEphemeralSynthesis(result, operation) {
  try { return await operation(result) } finally { releaseSynthesizedAudio(result) }
}
// Public descriptor never carries raw audio bytes into a response body.
export function publicAudioDescriptor(result) {
  if (!result?.audio) return null
  const { bytes, ...descriptor } = result.audio
  return { ...descriptor, ephemeral: true, expiresAt: null, persisted: false }
}
