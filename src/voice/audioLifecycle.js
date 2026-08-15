export async function withEphemeralAudio(audio, operation) {
  if (!Buffer.isBuffer(audio)) return operation(audio)
  try { return await operation(audio) } finally { audio.fill(0) }
}
export function publicAudioDescriptor(result) {
  if (!result?.audio) return null
  return { ...result.audio, ephemeral: true, expiresAt: null, persisted: false }
}
