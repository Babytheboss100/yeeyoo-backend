const TYPES = new Set(['comment','mention','direct_message','review'])
const PROVIDER = /^[a-z][a-z0-9_-]{1,31}$/
const INJECTION = /(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s*(?:prompt|message)|developer\s*message|reveal\s+(?:secrets?|credentials?)|act\s+as\s+(?:system|admin)|<\/?(?:system|assistant|tool)>)/i
const LEAD = /\b(?:price|pricing|quote|demo|buy|purchase|interested|book|contact|cost|pris|tilbud|kjøpe|interessert|kontakt)\b/i
const URGENT = /\b(?:urgent|asap|immediately|lawsuit|fraud|scam|security|breach|haster|svindel|sikkerhet)\b/i
const NEGATIVE = /\b(?:angry|awful|bad|broken|hate|terrible|refund|dårlig|ødelagt|misfornøyd)\b/i

const text = (value, max, field) => {
  const result=String(value ?? '').trim()
  if(!result || result.length>max) throw Object.assign(new Error(`${field} is invalid`),{code:'INVALID_ENGAGEMENT_INPUT'})
  return result
}

export function normalizeInteraction(input={}) {
  const kind=text(input.kind,32,'kind'); if(!TYPES.has(kind)) throw Object.assign(new Error('kind is invalid'),{code:'INVALID_ENGAGEMENT_INPUT'})
  const provider=text(input.provider,32,'provider').toLowerCase(); if(!PROVIDER.test(provider)) throw Object.assign(new Error('provider is invalid'),{code:'INVALID_ENGAGEMENT_INPUT'})
  const occurredAt=new Date(input.occurredAt); if(!Number.isFinite(occurredAt.getTime()) || occurredAt>Date.now()+300000) throw Object.assign(new Error('occurredAt is invalid'),{code:'INVALID_ENGAGEMENT_INPUT'})
  return Object.freeze({provider,providerAccountId:text(input.providerAccountId,200,'providerAccountId'),providerInteractionId:text(input.providerInteractionId,200,'providerInteractionId'),kind,authorRef:input.authorRef?text(input.authorRef,200,'authorRef'):null,body:text(input.body,10000,'body'),occurredAt:occurredAt.toISOString(),observedMetrics:normalizeMetrics(input.observedMetrics)})
}

export function normalizeMetrics(value={}) {
  const out={}; for(const key of ['likes','replies','shares','clicks']) { if(value[key]===undefined) continue; const n=Number(value[key]); if(!Number.isInteger(n)||n<0||n>1e9) throw Object.assign(new Error(`observedMetrics.${key} is invalid`),{code:'INVALID_ENGAGEMENT_INPUT'}); out[key]=n }
  return Object.freeze(out)
}

// Provider text is evidence, never an instruction. This deterministic classifier does not execute tools or interpolate prompts.
export function classifyInteraction(body) {
  const value=String(body||''); const promptInjection=INJECTION.test(value); const lead=LEAD.test(value); const urgent=URGENT.test(value)
  const sentiment=NEGATIVE.test(value)?'negative':/\b(?:love|great|excellent|thanks|takk|bra)\b/i.test(value)?'positive':'neutral'
  const complaint=NEGATIVE.test(value); const support=/\b(?:help|support|not working|error|problem|hjelp|feil|problem)\b/i.test(value); const question=/\?|\b(?:how|what|when|where|hvordan|hva|når|hvor)\b/i.test(value); const spam=/(?:https?:\/\/\S+\s*){3,}|\b(?:crypto giveaway|free followers)\b/i.test(value)
  const category=spam?'SPAM':lead?'LEAD':complaint?'COMPLAINT':support?'SUPPORT':sentiment==='positive'?'POSITIVE':sentiment==='negative'?'NEGATIVE':question?'QUESTION':'OTHER'
  const requiresHuman=urgent||promptInjection||category==='COMPLAINT'||category==='LEAD'
  return Object.freeze({schemaVersion:1,category,confidence:lead?.82:.65,urgency:urgent?'HIGH':'NORMAL',requires_human:requiresHuman,suggested_action:requiresHuman?'ESCALATE':'DRAFT_REPLY',sentiment,intent:lead?'commercial':'general',lead,urgent,promptInjection,requiresHuman})
}

export function evaluateTriggerRule(rule,classification,now=Date.now()) {
  const expires=Date.parse(rule?.expiresAt||rule?.expires_at)
  if(!rule?.enabled||!rule.approvalRequired&&!rule.approval_required||!Number.isFinite(expires)||expires<=now)return Object.freeze({matched:false,code:'RULE_INERT',executionStarted:false})
  const categories=Array.isArray(rule.pattern?.categories)?rule.pattern.categories:[]
  return Object.freeze({matched:categories.includes(classification?.category),code:categories.includes(classification?.category)?'SAFE_TRIGGER_MATCH':'NO_MATCH',suggestedAction:'CREATE_DRAFT',approvalRequired:true,executionStarted:false})
}

export function operatingModeForPolicy(level) {
  return Object.freeze({0:'observe',1:'draft',2:'plan',3:'approval_bound'}[Number(level)]?{level:Number(level),mode:{0:'observe',1:'draft',2:'plan',3:'approval_bound'}[Number(level)],mayDraft:Number(level)>=1,mayTriggerPlan:Number(level)>=2,mayExecute:false}:{level:0,mode:'observe',mayDraft:false,mayTriggerPlan:false,mayExecute:false})
}

export function buildReplyDraft({interaction,classification,brandName='the team'}) {
  if(!interaction?.body) throw Object.assign(new Error('interaction is required'),{code:'INVALID_ENGAGEMENT_INPUT'})
  const escalation=classification?.requiresHuman
  return Object.freeze({body:escalation?`Thanks for reaching out. A member of ${brandName} will review this and respond shortly.`:`Thanks for reaching out. ${brandName} appreciates your message.`,requiresHuman:Boolean(escalation),sourceBodyTreatedAsUntrusted:true})
}

export function buildDailyBrief(rows=[],date=new Date().toISOString().slice(0,10)) {
  const items=rows.map(row=>({classification:row.classification||{},observedMetrics:row.observed_metrics||row.observedMetrics||{}}))
  const sum=key=>items.reduce((n,x)=>n+Number(x.observedMetrics[key]||0),0)
  const observedPerformance={likes:sum('likes'),replies:sum('replies'),shares:sum('shares'),clicks:sum('clicks')}
  return Object.freeze({schemaVersion:1,date,totalInteractions:items.length,leads:items.filter(x=>x.classification.lead).length,requiresHuman:items.filter(x=>x.classification.requiresHuman).length,promptInjectionAttempts:items.filter(x=>x.classification.promptInjection).length,observedPerformance,learning:[{kind:'OBSERVATION',body:{totalInteractions:items.length,observedPerformance},evidence:'project-scoped interaction metrics'},{kind:'HYPOTHESIS',body:{text:'Patterns require more observed evidence before causal claims.'},evidence:[]},{kind:'RECOMMENDATION',body:{text:'Review human-required interactions first.'},evidence:'classification counts'}],missingMetricsAreOmitted:true})
}
