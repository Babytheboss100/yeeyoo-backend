# SESJON J — BACKEND KOMPLETT

_Ferdigstilt 2026-05-24. Alt i `yeeyoo-backend` (`main`), deler DB med yeeyoo-next._

## Features (11)

| # | Feature | Hovedendepunkter |
|---|---------|------------------|
| 1 | WhatsApp (multi-WABA) | `POST /api/whatsapp/send`, `GET/POST /api/whatsapp/webhook`, `/conversations`, `/accounts` |
| 1 | Facebook + Instagram | `POST /api/meta/facebook/post`, `POST /api/meta/instagram/post`, `GET /api/meta/accounts` |
| 2 | LinkedIn | `POST /api/linkedin/post`, `POST/GET /api/linkedin/accounts` |
| 3 | X (Twitter) | `POST /api/x/post`, `POST/GET /api/x/accounts` |
| 4 | TikTok | `POST /api/tiktok/post` (video), `POST/GET /api/tiktok/accounts` |
| 5 | Pinterest | `POST /api/pinterest/post`, `POST/GET /api/pinterest/accounts` |
| 6 | Threads | `POST /api/threads/post`, `POST/GET /api/threads/accounts` |
| 7 | YouTube | `POST /api/youtube/post` (video upload), `POST/GET /api/youtube/accounts` |
| 8 | Reddit | `POST /api/reddit/post`, `POST/GET /api/reddit/accounts` |
| — | Streak | auto-bump på `*.post`, `GET /api/streak/me` |
| — | AI-video | `POST /api/video/generate`, `GET /api/video/:id` (fal.ai async) |
| 6* | Inspo-bibliotek | `GET /api/inspo/niches(+/:slug/items)`, `POST /api/inspo/save`, `GET /api/inspo/saved`, admin `POST /api/inspo/items` |
| 7* | Yeeyoo Radar | `POST/GET/DELETE /api/radar/feeds`, `/feeds/:id/refresh`, `GET /api/radar/items`, admin `/refresh-all` |
| 8* | Inbox (IG/FB DM) | `GET/POST /api/inbox/webhook`, `POST /api/inbox/reply`, `GET /api/inbox/conversations(+/:id/messages)`, `POST /api/inbox/conversations/:id/suggest` |
| 9* | Klaviyo + Mailchimp | `POST /api/integrations/:provider/connect`, `/sync-contacts`, `/send-campaign`, `GET /api/integrations` |
| 11 | Photoshoot AI | `POST /api/photoshoot/generate`, `GET /api/photoshoot/:id` (FLUX 1.1 Pro async) |
| 11 | Translate-i-bilder | `POST /api/translate-image/generate` (OCR → oversett → valgfri inpaint) |

Tverrgående: AI-rate-limits (`checkAILimit`), token-kryptering (AES-256-GCM), audit-logg (`GET /api/audit`), tenant-isolasjon på alle nye queries.

**Gjenstår:** #10 Brand DNA 2.0 (3D-pretzel + Moodboard) — venter på design, hovedsakelig frontend.

## DB-migrasjoner (kjør MANUELT i Render Shell, i `migrations/`)

Kjør i denne rekkefølgen (alle idempotente):
```
2026-05-24_ai_usage.sql
2026-05-24_whatsapp.sql
2026-05-24_meta_accounts.sql
2026-05-24_audit_log.sql
2026-05-24_linkedin_accounts.sql
2026-05-24_x_accounts.sql
2026-05-24_tiktok_accounts.sql
2026-05-24_pinterest_accounts.sql
2026-05-24_threads_accounts.sql
2026-05-24_youtube_accounts.sql
2026-05-24_reddit_accounts.sql
2026-05-24_video_generations.sql
2026-05-24_inspo.sql              (inkl. seed av 14 nisjer)
2026-05-24_radar.sql
2026-05-24_inbox.sql
2026-05-24_email_integrations.sql
2026-05-24_photoshoot_translate.sql
```
users-kolonner (`last_project_id`, `streak_count`, `last_post_at`) auto-ALTER-es ved deploy.
Etter at tokens er lagt inn manuelt via SQL: kjør `node scripts/encrypt-tokens.js`.

## Env-vars i Render

**Kritisk / nye:**
| Variabel | Verdi | Merknad |
|----------|-------|---------|
| `META_TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` | ALDRI endre/generateValue — uleselige tokens ellers |
| `WHATSAPP_VERIFY_TOKEN` | selvvalgt streng | webhook-registrering |
| `META_VERIFY_TOKEN` | selvvalgt (valgfri) | faller tilbake til WHATSAPP_VERIFY_TOKEN |
| `REDDIT_USER_AGENT` | f.eks. `yeeyoo:v1.0 (by /u/...)` | valgfri, anbefalt |

**Må allerede finnes / brukes:** `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `FAL_KEY`, `META_APP_SECRET` (webhook-signatur), `GOOGLE_*`.

## Eksterne kontoer / dev-apper Heljar må opprette

| Plattform | Hva |
|-----------|-----|
| **Meta Business + App** | FB Page(s), IG business account, WhatsApp WABA ×2 (NO +47, BR +55), Threads, Messenger + IG-messaging webhooks. System user token. App review for IG/WhatsApp publishing. |
| **LinkedIn Developers** | App + `w_member_social` (krever app review). Author URN per konto. |
| **X Developer** | App, OAuth 2.0, **Basic/Pro tier** ($100–200/mnd) for posting. |
| **TikTok for Developers** | App + Content Posting API (app review). |
| **Pinterest Developers** | App + API v5-tilgang. |
| **Google Cloud / YouTube** | YouTube Data API v3, OAuth `youtube.upload`. |
| **Reddit** | App (script/web) + OAuth token. |
| **fal.ai** | Allerede aktiv (FLUX/video/photoshoot). |
| **Klaviyo / Mailchimp** | API-nøkler (kobles via `/connect`). |

## Webhook-URLer i Meta
- WhatsApp: `https://yeeyoo-backend.onrender.com/api/whatsapp/webhook`
- IG/FB DM: `https://yeeyoo-backend.onrender.com/api/inbox/webhook`

## Neste: FRONTEND (yeeyoo-next)
Bygge dashboard-UI for HOLO-features. Foreslått rekkefølge: konto-tilkobling
(connect-skjemaer) → publiserings-composer (multi-plattform) → Inbox → Radar →
Inspo → Photoshoot/Video → Streak-widget. #10 Brand DNA 2.0 når design er klar.
