/**
 * Yeeyoo Email Service — SendGrid
 */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'no-reply@yeeyoo.no'

export async function sendEmail(to, subject, html) {
  if (!SENDGRID_API_KEY) {
    console.log(`📧 [DEV] → ${to}: ${subject}`)
    return false
  }
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM_EMAIL, name: 'Yeeyoo' },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    })
    if (!r.ok) console.error('SendGrid error:', r.status, await r.text())
    return r.ok
  } catch (e) {
    console.error('Email error:', e.message)
    return false
  }
}

export async function sendVerificationEmail(email, name, token) {
  const url = `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/auth/verify?token=${token}`
  return sendEmail(email, 'Bekreft e-postadressen din — Yeeyoo', `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#050714;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
        <tr><td align="center">
          <table width="520" cellpadding="0" cellspacing="0" style="background:linear-gradient(145deg,rgba(12,17,48,.98),rgba(8,12,30,.98));border:1px solid rgba(255,255,255,.13);border-radius:16px;overflow:hidden;">
            <tr><td style="padding:32px 40px;text-align:center;">
              <div style="font-size:28px;font-weight:800;color:#f0f4ff;margin-bottom:8px;">Velkommen til Yeeyoo!</div>
              <p style="color:#8892b0;font-size:15px;margin-bottom:24px;">Hei ${name}, bekreft e-postadressen din for å aktivere kontoen.</p>
              <a href="${url}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#2d5be3,#7c3aed);color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Bekreft e-post →</a>
              <p style="color:#4a5278;font-size:12px;margin-top:24px;">Linken er gyldig i 24 timer.</p>
              <hr style="border:none;border-top:1px solid rgba(255,255,255,.07);margin:24px 0;">
              <p style="color:#4a5278;font-size:11px;">Yeeyoo · AI-drevet markedsføring</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body></html>
  `)
}
