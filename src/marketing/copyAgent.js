const text = value => String(value || '').trim()
export function generateCopy(input, context = {}) {
  const objective=text(input.objective); const audience=text(input.audience); const offer=text(input.offer)
  if(!objective || !audience || !offer) throw new Error('objective, audience and offer are required')
  const brand=text(context.profile?.brand?.name) || 'Your brand'; const tone=text(input.tone) || 'clear'; const channel=text(input.channel) || 'web'
  const headline=`${offer} for ${audience}`; const cta=objective.toLowerCase().includes('lead') ? 'Get started' : 'Learn more'
  return { headline, subheadline:`${brand} helps ${audience} achieve ${objective} with ${tone} guidance.`, cta,
    landingPageSections:[{heading:'The challenge',body:`Built for ${audience}.`},{heading:'The offer',body:offer},{heading:'Next step',body:cta}],
    socialCopy:`${headline}. ${cta}.`, adCopy:{primaryText:`${brand}: ${offer}.`,headline,description:`A ${tone} path to ${objective}.`},
    email:{subject:headline,body:`Hi,\n\n${brand} created ${offer} for ${audience}.\n\n${cta}.`}, description:`${offer} from ${brand}.`, variants:[`${headline} — ${cta}`,`${objective}: ${offer}`], channel }
}
