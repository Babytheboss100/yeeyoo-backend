// Sanitized feilrespons — samme policy som voice-turn (d80632e), gjort gjenbrukbar.
//
// Kun feil KODEN VÅR har mintet slipper gjennom til klienten: numerisk
// `status` i [400, 600) OG en SCREAMING_SNAKE `code`. Alt annet (pg-feil,
// provider-feil, TypeError, Stripe-exceptions) blir generisk 500 — meldingen,
// SQLSTATE-koden, tabellnavn og stack forblir i server-loggen.
//
// Bruk:  } catch (e) { return sendSafeError(res, e, 'smartplan/analyze') }

const APP_CODE = /^[A-Z][A-Z0-9_]*$/

export function sendSafeError(res, e, context = '') {
  const status = Number(e?.status)
  const code = typeof e?.code === 'string' && APP_CODE.test(e.code) ? e.code : null
  if (Number.isInteger(status) && status >= 400 && status < 600 && code) {
    return res.status(status).json({ error: e.message, code })
  }
  // Intern logg beholder detaljene — responsen gjør det ikke.
  console.error(`[safeError]${context ? ' ' + context : ''}`, e?.code ?? '', e?.message ?? e)
  return res.status(500).json({ error: 'Internal server error' })
}
