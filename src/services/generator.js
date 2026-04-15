// ─── Yeeyoo Multi-AI Generator ──────────────────────────────────────────────
export const AI_MODELS = {
  claude:   { id:'claude',   label:'Claude',   color:'#c96442', envKey:'ANTHROPIC_API_KEY' },
  gpt4o:    { id:'gpt4o',    label:'GPT-4o',   color:'#10a37f', envKey:'OPENAI_API_KEY' },
  gemini:   { id:'gemini',   label:'Gemini',   color:'#4285f4', envKey:'GEMINI_API_KEY' },
  grok:     { id:'grok',     label:'Grok',     color:'#aaaaaa', envKey:'GROK_API_KEY' },
  deepseek: { id:'deepseek', label:'DeepSeek', color:'#5e6ad2', envKey:'DEEPSEEK_API_KEY' }
}

const PLATFORM_RULES = {
  linkedin: {
    maxChars:700,
    style:'Profesjonell og innsiktsdrevet tone. MAKS 700 tegn totalt. INGEN emojis. Start med en sterk innsikt eller kontraintuitiv påstand. Bruk korte avsnitt med linjeskift. Del personlig erfaring eller data. Avslutt med en refleksjon eller CTA. 3-5 relevante hashtags på slutten.',
    format:'Sterk innsikt/hook (1 setning)\n\n[Avsnitt 1 - kontekst]\n\n[Avsnitt 2 - hovedpoeng med data/erfaring]\n\n[Avsnitt 3 - lærdom/takeaway]\n\n[CTA - spørsmål til leseren]\n\n#hashtag1 #hashtag2 #hashtag3'
  },
  facebook: {
    maxChars:2000,
    style:'Konversasjonell og varm tone. 100-200 ord. Maks 1-2 emojis. Skriv som om du snakker med en venn. Bruk korte setninger. Avslutt ALLTID med et spørsmål som inviterer til kommentar.',
    format:'Hook (kort, personlig)\n\nKropp (2-3 korte avsnitt)\n\nSpørsmål til leserne?'
  },
  instagram: {
    maxChars:2200,
    style:'Visuelt og inspirerende. Maks 150 ord i selve teksten. 3-5 emojis strategisk plassert. Første linje MÅ fange oppmerksomhet — dette er det eneste folk ser før "les mer". Inkluder CTA (lagre, del, kommenter). 15-20 hashtags på slutten etter punktlinje.',
    format:'🔥 Sterk første linje (hook)\n\nKort kropp (3-4 setninger maks)\n\nCTA (Lagre dette! / Tag en venn / Kommenter)\n\n.\n.\n.\n#hashtag1 #hashtag2 ... (15-20 stk)'
  },
  twitter: {
    maxChars:280,
    style:'Kun ÉN idé. Punchy og direkte. Maks 280 tegn totalt. Ingen fluff. Sterk mening eller overraskende innsikt. Maks 1-2 hashtags. Kan bruke 1 emoji for effekt.',
    format:'Én sterk setning. Maks 280 tegn.'
  },
  tiktok: {
    maxChars:300,
    style:'Ultra-kort hook i første setning (fang oppmerksomhet på 1 sekund). Maks 100 ord. Trendy og autentisk språk. Bruk emojis. Oppfordre til å følge, kommentere, eller dele. Snakk direkte til seeren.',
    format:'HOOK: [1 setning som stopper scrolling]\n\n[Kort kropp - maks 3 setninger]\n\n[CTA - følg for mer / kommenter X / del med en venn]\n\n#trending #hashtags (5-8)'
  },
  email: {
    maxChars:5000,
    style:'Profesjonell men personlig e-post. Tydelig emne-linje som skaper nysgjerrighet (maks 50 tegn). Personlig hilsen. Verdifull kropp i 2-4 korte avsnitt. Én tydelig CTA-knapp. Kort og respektfull avslutning.',
    format:'EMNE: [Kort, nysgjerrighetsskapende emnelinje]\n\nHei [Navn],\n\n[Avsnitt 1 - personlig hook]\n\n[Avsnitt 2 - verdi/innhold]\n\n[Avsnitt 3 - CTA med link]\n\nMvh,\n[Avsender]'
  }
}

export const TEMPLATES = [
  { id:'customer_acquisition', label:'Kundeakkvisisjon', emoji:'🎯', description:'Tiltrekk nye kunder',
    prompt:'Skriv innhold som rekrutterer nye kunder. Fremhev verdiforslag og fordeler. Tydelig CTA. Bruk PROBLEM-SOLUTION struktur: Start med et problem målgruppen kjenner seg igjen i → vis at du forstår frustrasjonen → presenter løsningen → tydelig CTA.' },
  { id:'product_launch', label:'Produktlansering', emoji:'🚀', description:'Annonsér nytt produkt/tjeneste',
    prompt:'Annonsér lansering av nytt produkt/tjeneste. BEFORE/AFTER struktur: Vis HVORDAN ting var FØR → hva som endres NÅ → konkrete fordeler → urgency (begrenset tilbud/tidlig tilgang). Skap begeistring. CTA: prøv nå / meld deg på.' },
  { id:'milestone', label:'Milepæl / suksess', emoji:'🏆', description:'Del en milepæl',
    prompt:'Del en viktig milepæl. STATISTICS struktur: Start med det imponerende tallet → gi kontekst (hva det betyr) → takk kunder/team → del hva som kommer neste → CTA. Bruk konkrete tall og prosenter.' },
  { id:'educational', label:'Utdanning / tips', emoji:'📚', description:'Del kunnskap og ekspertise',
    prompt:'Lag utdannende innhold. FAQ/TIPS struktur: Start med et vanlig spørsmål eller misforståelse → gi tydelig, verdiladet svar → bruk nummererte steg eller kulepunkter → avslutt med en bonus-innsikt. Posisjonér som ekspert uten hard selg.' },
  { id:'trust_builder', label:'Tillit & troverdighet', emoji:'🛡️', description:'Bygg tillit og merkevare',
    prompt:'Skriv innhold som bygger tillit. TESTIMONIAL struktur: Del en ekte historie eller kundeerfaring → hva var situasjonen FØR → hva skjedde ETTER → konkrete resultater med tall → lærdom andre kan ta med seg. Autentisk tone.' },
  { id:'engagement', label:'Engasjement', emoji:'💬', description:'Driv interaksjon og diskusjon',
    prompt:'Skriv innhold som skaper kommentarer. MYTHBUSTER struktur: Start med en kontrovers eller vanlig myte ("De fleste tror at...") → avkreft med fakta og logikk → del din egen erfaring → avslutt med et åpent spørsmål som inviterer til debatt.' },
  { id:'offer', label:'Tilbud / kampanje', emoji:'🎁', description:'Promoter et tilbud',
    prompt:'Promoter et tilbud. NEGATIVE HOOK struktur: Start med hva folk gjør FEIL eller hva de MISTER ved å ikke handle ("Slutt å kaste penger på...") → presenter tilbudet som løsningen → tydelig verdi og besparelse → urgency (frist/begrenset) → enkel CTA.' },
  { id:'faq', label:'FAQ', emoji:'❓', description:'Svar på vanlige spørsmål',
    prompt:'FAQ-innhold: Velg det vanligste spørsmålet bransjen din får → formuler det som "folk spør meg alltid..." → gi et kort, presist og verdifullt svar → legg til 1-2 bonus-tips de ikke forventet → inviter til flere spørsmål.' },
  { id:'before_after', label:'Før & Etter', emoji:'🔄', description:'Vis transformasjon og resultater',
    prompt:'BEFORE/AFTER innhold: Beskriv NØYAKTIG hvordan situasjonen var FØR (smertepunkter, tall, frustrasjon) → hva som ble endret/implementert → beskriv NØYAKTIG hvordan det er ETTER (resultater, tall, forbedring) → lærdom → CTA.' },
  { id:'mythbuster', label:'Mythbuster', emoji:'💥', description:'Avkreft bransjemyter',
    prompt:'MYTHBUSTER innhold: Start med en sterk påstand: "MYTE: [vanlig oppfatning]" → forklar hvorfor dette er feil med data/logikk → del "SANNHETEN: [riktig innsikt]" → gi praktisk råd basert på sannheten → inviter til diskusjon.' },
  { id:'custom', label:'Egendefinert', emoji:'✏️', description:'Skriv din egen instruksjon', prompt:'' }
]

function buildPrompts({ project, templateId, customPrompt, platform, extraContext }) {
  const template = TEMPLATES.find(t => t.id === templateId)
  const rules = PLATFORM_RULES[platform]
  const basePrompt = templateId === 'custom' ? customPrompt : template.prompt
  const ctx = project ? `\nBedrift: ${project.name}\nOm: ${project.about||'–'}\nTone: ${project.tone||'profesjonell'}\nMålgruppe: ${project.audience||'–'}\nNøkkelord: ${project.keywords||'–'}` : ''
  const system = `Du er en ekspert på digital markedsføring. Du skriver innhold for ${project?.name||'en bedrift'}.${ctx}\n\nPLATTFORM: ${platform.toUpperCase()}\nREGLER: ${rules.style}\nFORMAT: ${rules.format}\nMAKS TEGN: ${rules.maxChars}\n\nSvar KUN med selve innholdet — ingen forklaringer, bare teksten direkte.`
  const user = `OPPGAVE: ${basePrompt}\n${extraContext?`TILLEGGSKONTEKST: ${extraContext}`:''}\n\nGenerer ${platform}-innhold nå.`
  return { system, user }
}

async function generateClaude({ system, user, apiKey }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1000, system, messages:[{role:'user',content:user}] })
  })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'Claude feil') }
  const d = await r.json(); return d.content[0].text
}

async function generateGPT4o({ system, user, apiKey }) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model:'gpt-4o', max_tokens:1000, messages:[{role:'system',content:system},{role:'user',content:user}] })
  })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'GPT-4o feil') }
  const d = await r.json(); return d.choices[0].message.content
}

async function generateGemini({ system, user, apiKey }) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ system_instruction:{parts:[{text:system}]}, contents:[{parts:[{text:user}]}], generationConfig:{maxOutputTokens:1000} })
  })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'Gemini feil') }
  const d = await r.json(); return d.candidates[0].content.parts[0].text
}

async function generateGrok({ system, user, apiKey }) {
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model:'grok-4-1-fast', max_tokens:1000, messages:[{role:'system',content:system},{role:'user',content:user}] })
  })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'Grok feil') }
  const d = await r.json(); return d.choices[0].message.content
}

async function generateDeepSeek({ system, user, apiKey }) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model:'deepseek-chat', max_tokens:1000, messages:[{role:'system',content:system},{role:'user',content:user}] })
  })
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'DeepSeek feil') }
  const d = await r.json(); return d.choices[0].message.content
}

export async function generateContent({ project, templateId, customPrompt, platform, extraContext, aiModels, keys }) {
  const { system, user } = buildPrompts({ project, templateId, customPrompt, platform, extraContext })
  const tasks = aiModels.map(async modelId => {
    const apiKey = keys[modelId]
    if (!apiKey) throw new Error(`Ingen API-nøkkel for ${modelId}`)
    let text
    if (modelId==='claude')  text = await generateClaude({ system, user, apiKey })
    else if (modelId==='gpt4o')    text = await generateGPT4o({ system, user, apiKey })
    else if (modelId==='gemini')   text = await generateGemini({ system, user, apiKey })
    else if (modelId==='grok')     text = await generateGrok({ system, user, apiKey })
    else if (modelId==='deepseek') text = await generateDeepSeek({ system, user, apiKey })
    else throw new Error(`Ukjent AI: ${modelId}`)
    return { modelId, text }
  })
  const results = await Promise.allSettled(tasks)
  return results.map(r => ({
    modelId: r.status==='fulfilled' ? r.value.modelId : null,
    text:    r.status==='fulfilled' ? r.value.text    : null,
    error:   r.status==='rejected'  ? r.reason?.message : null
  }))
}

/**
 * Generate a relevant image based on post content.
 * Uses AI to create a focused image prompt, then Pollinations.ai for generation.
 */
export function generateImagePrompt(text, project) {
  const content = text.substring(0, 200)

  // Detect theme from content
  const isProduct = /lanser|produkt|nyhet|launch|product/i.test(content)
  const isTeam = /team|ansatt|medarbeider|kolleg/i.test(content)
  const isData = /resultat|vekst|tall|prosent|growth|data/i.test(content)
  const isEvent = /event|konferanse|webinar|møte/i.test(content)
  const isNature = /miljø|bærekraft|grønn|natur|sustain/i.test(content)

  let style = 'modern business office professional photography'
  if (isProduct) style = 'product showcase minimalist studio lighting'
  else if (isTeam) style = 'diverse team modern office collaboration'
  else if (isData) style = 'business dashboard data visualization growth'
  else if (isEvent) style = 'professional conference networking event'
  else if (isNature) style = 'sustainable green technology nature'

  // Extract 3 short keywords only (letters and spaces)
  const keywords = content
    .replace(/[^a-zA-ZæøåÆØÅ\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && w.length < 15)
    .slice(0, 3)
    .join(' ')

  // Keep prompt SHORT — Pollinations fails on long URLs
  const short = `${style} ${keywords} photorealistic no text`.substring(0, 150)
  return short
}
