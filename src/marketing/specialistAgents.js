const clean = (value, fallback = '') => String(value ?? fallback).trim()
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value)).filter(Boolean))]
const first = (values, fallback) => unique(values)[0] || fallback

export const SPECIALIST_SCHEMA_VERSION = 1
export const SPECIALIST_KINDS = Object.freeze(['social', 'seo', 'email', 'ads'])

function base(kind, input, context) {
  const objective = clean(input.objective, first(context.profile?.objectives, 'Build qualified awareness'))
  const audience = clean(input.audience, first(context.profile?.audiences, 'the project audience'))
  const offer = clean(input.offer, first(context.profile?.offers, 'the project offer'))
  if (!objective || !audience || !offer) throw new Error('objective, audience and offer are required')
  return {
    schemaVersion: SPECIALIST_SCHEMA_VERSION, kind, objective, audience, offer,
    mode: 'deterministic-offline-draft', executable: false,
    provenance: {
      marketingProfileVersion: context.profile?.version ?? null,
      competitorIds: unique(context.competitors?.map(item => item.id)),
      evidenceIds: unique(context.competitors?.flatMap(item => item.evidenceIds || [])),
      generatedFrom: ['marketing-profile', ...(context.competitors?.length ? ['competitor-evidence'] : [])],
    },
  }
}

export function generateSocialStrategy(input, context = {}) {
  const value = base('social', input, context)
  const requested = unique(input.channels?.length ? input.channels : context.profile?.channels).map(channel => channel.toLowerCase())
  const supported = ['facebook','instagram','linkedin','x','threads','pinterest','reddit','tiktok','youtube']
  const channels = (requested.length ? requested : ['linkedin','instagram']).filter(channel => supported.includes(channel.toLowerCase()))
  const connections = new Map((context.connections || []).map(item => [item.provider, item.status]))
  return { ...value,
    channels: channels.map(channel => ({ channel, connectionStatus: connections.get(channel === 'facebook' || channel === 'instagram' ? 'meta' : channel) || 'not_connected', recommendationOnly: true })),
    contentPillars: [`Teach ${value.audience}`, `Show how ${value.offer} works`, `Build trust around ${value.objective}`],
    postingCadence: channels.map(channel => ({ channel, postsPerWeek: channel === 'youtube' ? 1 : 3 })),
    themes: ['education','proof','offer'], campaignConcepts: [`${value.offer}: from problem to progress`],
    hooks: [`A practical way for ${value.audience} to ${value.objective}`], ctaStrategy: 'Invite the audience to learn more before asking for commitment',
    formats: ['short-form post','carousel','short video'],
    draftCalendar: channels.slice(0, 3).map((channel, index) => ({ dayOffset: index * 2, channel, theme: ['education','proof','offer'][index], status: 'draft' })),
  }
}

export function generateSeoPlan(input, context = {}) {
  const value = base('seo', input, context); const keywords = unique([...unique(input.keywords), ...unique(context.profile?.keywords)])
  const topics = keywords.length ? keywords : [value.offer, value.objective]
  const observations = (context.competitors || []).flatMap(item => (item.observations || []).map(text => ({ competitorId: item.id, text, evidenceRequired: true })))
  return { ...value, searchIntent: clean(input.searchIntent, 'commercial investigation'),
    topicClusters: topics.map(topic => ({ topic, keywords: [topic], source: keywords.includes(topic) ? 'profile-or-request' : 'project-context' })),
    contentGaps: observations.length ? observations.map(item => ({ opportunity: item.text, evidence: item })) : [{ opportunity: `Create evidence-led content for ${value.offer}`, evidence: null }],
    competitorObservations: observations, pageRecommendations: [{ pageType:'landing-page', topic:topics[0], rationale:`Align ${value.offer} with ${value.audience}` }],
    titleMeta: [{ topic:topics[0], title:`${value.offer} for ${value.audience}`, metaDescription:`Learn how ${value.offer} supports ${value.objective}.` }],
    contentBriefs: topics.slice(0,3).map(topic => ({ topic, intent:'help the audience evaluate the offer', requiredEvidence:[] })),
    internalLinks: [{ from:'supporting-content', to:'offer-page', anchor:value.offer }],
    actionPlan: [{ order:1, action:'Validate keyword demand with an approved data provider', status:'requires-provider-data' }, { order:2, action:'Draft the primary offer page', status:'draftable-offline' }],
  }
}

export function generateEmailPlan(input, context = {}) {
  const value = base('email', input, context); const sequenceType = clean(input.sequenceType, 'campaign')
  const providers = ['mailchimp','klaviyo'].map(provider => ({ provider, status:(context.connections || []).find(item => item.provider === provider)?.status || 'not_connected', sendEnabled:false }))
  const subject = `${value.offer} for ${value.audience}`
  return { ...value, sequenceType, providerStatus:providers, sendPolicy:'draft-only-never-send',
    segmentation:[{ segment:value.audience, rationale:`Relevant to ${value.objective}`, hypothesis:true }],
    messages:[{ order:1, role:'introduction', subject, subjectVariants:[subject,`${value.objective}: a practical next step`], previewText:`A clear introduction to ${value.offer}.`, bodyOutline:['Audience problem','Offer value','Evidence required before claims','Next step'], cta:'Learn more', status:'draft' }],
  }
}

export function generateAdsPlan(input, context = {}) {
  const value = base('ads', input, context); const platforms = (unique(input.platforms).length ? unique(input.platforms) : ['meta','google-search']).map(platform => platform.toLowerCase())
  const budget = Number(input.budget); const safeBudget = Number.isFinite(budget) && budget > 0 ? budget : null
  return { ...value, planningOnly:true, predictedRoas:null,
    platforms:platforms.map(platform => ({ platform, providerStatus:(context.connections || []).find(item => item.provider === (platform === 'instagram' ? 'meta' : platform))?.status || 'not_connected', executionEnabled:false })),
    audienceHypotheses:[{ audience:value.audience, basis:'project context', requiresValidation:true }],
    campaignStructure:platforms.map(platform => ({ platform, objective:value.objective, groups:[{ name:`${value.audience} - ${value.offer}`, status:'draft' }] })),
    creative:{ hooks:[`A clearer path to ${value.objective}`], headlines:[`${value.offer} for ${value.audience}`], primaryText:[`Explore ${value.offer}. Validate every claim before launch.`], cta:'Learn more', briefs:[{ format:'static-or-short-video', concept:`Show the problem and how ${value.offer} addresses it`, evidenceRequired:true }] },
    landingPageAlignment:{ offer:value.offer, audience:value.audience, status:'requires-review' },
    testingMatrix:[{ variable:'headline', variants:2, hypothesis:true }],
    budgetRecommendation:{ total:safeBudget, currency:clean(input.currency,'NOK'), allocation:safeBudget ? platforms.map(platform => ({ platform, amount:Number((safeBudget/platforms.length).toFixed(2)) })) : [], recommendationOnly:true },
  }
}

export const specialistGenerators = Object.freeze({ social:generateSocialStrategy, seo:generateSeoPlan, email:generateEmailPlan, ads:generateAdsPlan })
