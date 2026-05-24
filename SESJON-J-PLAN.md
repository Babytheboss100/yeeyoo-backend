# SESJON J — HOLO roadmap

_Opprettet 2026-05-24. Bygges i `yeeyoo-backend` (deler DB med yeeyoo-next/Render Postgres)._

## ⚠️ Antakelser som må bekreftes
- **Repo/DB:** Skjemaet refererer `users(id)` og `projects(id)` via FK — de finnes kun i
  yeeyoo-backend sin database. Multi-WABA-backenden bygges derfor her. "HOLO" tolkes som
  kodenavn/roadmap for yeeyoo (alle 10 punktene er yeeyoo-domene). Ingen egen HOLO-repo funnet.
- **FB + IG + frontend ("forrige melding"):** spesifikasjonen for Facebook/Instagram-endepunkter
  og frontend er ikke mottatt. Denne sesjonen leverer **WhatsApp-kjernen** (fullt spesifisert).
  FB/IG venter på spec.
- **Inbound eierskap (v1):** `whatsapp_business_accounts` har ingen owner-kolonne. Innkommende
  meldinger fra ukjent nummer knyttes til admin-brukeren (Heljar eier begge numre i v1).
  Revurderes når WABA blir multi-tenant.

## Provider-beslutning: Meta WhatsApp Cloud API (direkte)

Valgt **direkte mot Meta Cloud API** (Graph API), ikke en BSP.

**Begrunnelse:**
- Skjemaet er allerede modellert på Cloud API-primitiver (`phone_number_id`, `waba_id`,
  `system_user_token`, `meta_message_id`, `messaging_tier`, `quality_rating`).
- Gratis Meta-hostet sending (ingen BSP-markup per melding); kun Metas samtale-baserte priser.
- **Multi-WABA fra dag 1** er native: én rad per WABA, hver med eget `phone_number_id` +
  system-user-token. NO (+47) og BR (+55) lever side om side.
- Heljar gjør Meta Business-verifisering selv → ingen grunn til å betale et mellomledd.

**Vurderte og forkastede alternativer:**
- _360dialog / Twilio (BSP):_ enklere onboarding og pen API, men per-melding-påslag + et
  mellomledd vi ikke trenger når vi eier Meta Business-kontoen.
- _MessageBird/Vonage:_ samme BSP-innvending.

## Multi-WABA arkitektur

**Tabeller** (`migrations/2026-05-24_whatsapp.sql`, kjøres manuelt i Render Shell):
`whatsapp_business_accounts` (én rad per WABA/nummer), `whatsapp_conversations`,
`whatsapp_messages`.

**Routing (utgående):** `locale='pt-BR' → BR-WABA`, `locale='no' → NO-WABA`, fallback **NO-WABA**.
**Routing (innkommende):** Metas webhook gir `phone_number_id` → slå opp riktig WABA-rad → upsert
samtale på `(waba_account_id, customer_phone)`.

**Endepunkter** (`src/routes/whatsapp.js`, montert `/api/whatsapp`):
- `GET  /webhook` — Meta verifikasjon (`hub.verify_token` mot `WHATSAPP_VERIFY_TOKEN`).
- `POST /webhook` — innkommende meldinger (X-Hub-Signature-256 verifisert mot `META_APP_SECRET`).
- `POST /send` — send tekst/template via riktig WABA (autentisert).
- `GET  /accounts` — liste WABAer (uten token) (autentisert).
- `GET  /conversations`, `GET /conversations/:id/messages` — inbox (autentisert).

**Sikkerhet:** `system_user_token` lagres i klartekst per skjema — **bør krypteres** (eller flyttes
til Render secret-store / per-WABA env). Flagget for oppfølging.

**Nye env-vars (Render):** `WHATSAPP_VERIFY_TOKEN` (selvvalgt streng for webhook-registrering).
`META_APP_SECRET` finnes allerede.

## Roadmap (prioritert)
1. **WhatsApp Business API (multi-WABA)** ← _pågår_
2. Streak gamification
3. 4 nye plattformer (Pinterest, Threads, YouTube, Reddit)
4. AI-video MVP
5. Inspo-bibliotek 14 niches
6. Yeeyoo Radar
7. Inbox
8. Klaviyo + Mailchimp
9. Brand DNA 2.0
10. Photoshoot AI + Translate
