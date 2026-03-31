// ─── GeirX Multi-AI Generator ─────────────────────────────────────────────
export const AI_MODELS = {
  claude:   { id:'claude',   label:'Claude',   color:'#c96442', envKey:'ANTHROPIC_API_KEY' },
  gpt4o:    { id:'gpt4o',    label:'GPT-4o',   color:'#10a37f', envKey:'OPENAI_API_KEY' },
  gemini:   { id:'gemini',   label:'Gemini',   color:'#4285f4', envKey:'GEMINI_API_KEY' },
  grok:     { id:'grok',     label:'Grok',     color:'#aaaaaa', envKey:'GROK_API_KEY' },
  deepseek: { id:'deepseek', label:'DeepSeek', color:'#5e6ad2', envKey:'DEEPSEEK_API_KEY' }
}

const PLATFORM_RULES = {
  linkedin:  { maxChars:3000, style:'Profesjonell men personlig. Sterk hook. Linjeskift. CTA. Hashtags på slutten.', format:'Hook\n\nKropp (3-5 avsnitt)\n\nCTA\n\n#hashtags' },
  facebook:  { maxChars:2000, style:'Engasjerende og konversasjonell. Kortere avsnitt. Still et spørsmål.', format:'Hook → Kropp → Spørsmål/CTA' },
  instagram: { maxChars:2200, style:'Visuelt og inspirerende. Første linje avgjørende. Moderate emojis. Mange hashtags.', format:'Sterk første linje\n\nKort kropp\n\n.\n.\n.\n#hashtags (15-20)' },
  twitter:   { maxChars:280,  style:'Direkte og klar. Én sterk påstand. Maks 2 hashtags.', format:'Maks 280 tegn.' },
  tiktok:    { maxChars:2200, style:'Energisk, underholdende og autentisk. Hook i første setning. Trendy språk. Emojis. Oppfordring til å følge/kommentere.', format:'Hook → Kort kropp → CTA (følg, kommenter, del) → #hashtags (5-10 trending)' }
}

export const TEMPLATES = [
  { id:'customer_acquisition', label:'Kundeakkvisisjon',     emoji:'🎯', description:'Tiltrekk nye kunder',               prompt:'Skriv innhold som rekrutterer nye kunder. Fremhev verdiforslag og fordeler. Tydelig CTA.' },
  { id:'product_launch',       label:'Produktlansering',     emoji:'🚀', description:'Annonsér nytt produkt/tjeneste',    prompt:'Annonsér lansering av nytt produkt/tjeneste. Skap begeistring og urgency. CTA: prøv nå.' },
  { id:'milestone',            label:'Milepæl / suksess',    emoji:'🏆', description:'Del en milepæl',                   prompt:'Del en viktig milepæl. Bruk konkrete tall. Takk kunder. Bygg tillit og momentum.' },
  { id:'educational',          label:'Utdanning / tips',     emoji:'📚', description:'Del kunnskap og ekspertise',        prompt:'Lag utdannende innhold med verdi for målgruppen. Posisjonér som ekspert. Ingen hard selg.' },
  { id:'trust_builder',        label:'Tillit & troverdighet', emoji:'🛡️', description:'Bygg tillit og merkevare',         prompt:'Skriv innhold som bygger tillit. Fremhev erfaring, resultater, anerkjennelser.' },
  { id:'engagement',           label:'Engasjement',          emoji:'💬', description:'Driv interaksjon og diskusjon',     prompt:'Skriv innhold som skaper kommentarer. Still spørsmål, del meninger, inviter til diskusjon.' },
  { id:'offer',                label:'Tilbud / kampanje',    emoji:'🎁', description:'Promoter et tilbud',                prompt:'Promoter et spesielt tilbud. Skap urgency. Tydelig verdi og enkel CTA.' },
  { id:'custom',               label:'Egendefinert',         emoji:'✏️', description:'Skriv din egen instruksjon',        prompt:'' }
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`, {
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
    body: JSON.stringify({ model:'grok-2-latest', max_tokens:1000, messages:[{role:'system',content:system},{role:'user',content:user}] })
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
