// ─── Industry Templates for Yeeyoo ──────────────────────────────────────────
// Pre-built project configurations per industry

export const INDUSTRY_TEMPLATES = [
  {
    id: 'fintech',
    name: 'Fintech / Finanstjenester',
    emoji: '💰',
    color: '#2d5be3',
    tone: 'Profesjonell, trygg og transparent. Bygg tillit med tall og fakta.',
    audience: 'Privatinvestorer, gründere, finansinteresserte 25-55 år',
    keywords: 'investering, avkastning, crowdfunding, fintech, lån, rente, portefølje',
    about: 'Vi tilbyr finanstjenester og investeringsplattform for privatpersoner.',
    prompts: [
      { label: 'Markedsoppdatering', prompt: 'Skriv et markedsoppdatering-innlegg med nøkkeltall og trender. Vis ekspertise.' },
      { label: 'Investortips', prompt: 'Del et praktisk investeringstips. Enkel forklaring, konkret eksempel.' },
      { label: 'Milepæl', prompt: 'Vi har passert en viktig milepæl. Del nyheten med begeistring og takk investorene.' },
    ]
  },
  {
    id: 'ecommerce',
    name: 'E-handel / Nettbutikk',
    emoji: '🛒',
    color: '#f59e0b',
    tone: 'Engasjerende, visuell og salgsorientert. Skap FOMO og urgency.',
    audience: 'Online shoppere 20-45 år, trendsettere, prisbevisste forbrukere',
    keywords: 'netthandel, tilbud, kampanje, gratis frakt, bestselger, nyheter',
    about: 'Vi selger produkter online og ønsker å drive trafikk til nettbutikken.',
    prompts: [
      { label: 'Produktlansering', prompt: 'Lanser et nytt produkt med begeistring. Vis fordeler og skap urgency.' },
      { label: 'Flash Sale', prompt: 'Annonser et tidsbegrenset tilbud. Skap FOMO med countdown og rabatt.' },
      { label: 'Kundehistorie', prompt: 'Del en ekte kundehistorie/anmeldelse. Bygg sosial bevis.' },
    ]
  },
  {
    id: 'restaurant',
    name: 'Restaurant / Mat & Drikke',
    emoji: '🍽️',
    color: '#ef4444',
    tone: 'Varm, innbydende og sanselig. Beskriv smaker, dufter og opplevelser.',
    audience: 'Matentusiaster, lokale innbyggere, familier, par 25-55 år',
    keywords: 'restaurant, meny, lokal mat, sesong, vin, opplevelse, reservasjon',
    about: 'Vi driver restaurant og ønsker å tiltrekke gjester og bygge merkevare.',
    prompts: [
      { label: 'Ukens meny', prompt: 'Presenter ukens spesialrett. Beskriv ingredienser og smaker levende.' },
      { label: 'Bak kulissene', prompt: 'Vis et glimt bak kulissene — kokken, råvarene, forberedelsene.' },
      { label: 'Event/kveld', prompt: 'Annonser et kommende arrangement — vinkveld, live musikk, tema-aften.' },
    ]
  },
  {
    id: 'realestate',
    name: 'Eiendom / Bolig',
    emoji: '🏠',
    color: '#16a34a',
    tone: 'Profesjonell, aspirasjonell og lokal. Vis drømmeboligen.',
    audience: 'Boligkjøpere, investorer, utleiere, førstegangskjøpere 28-55 år',
    keywords: 'eiendom, bolig, leilighet, salg, utleie, investering, visning',
    about: 'Vi formidler eiendom og hjelper kunder med kjøp, salg og utleie.',
    prompts: [
      { label: 'Ny bolig', prompt: 'Presenter en ny bolig til salgs. Fremhev unike egenskaper og beliggenhet.' },
      { label: 'Markedstips', prompt: 'Del et tips om boligmarkedet. Vis ekspertise og gi verdifull innsikt.' },
      { label: 'Solgt!', prompt: 'Del at en bolig er solgt. Gratulerer kjøper og selger. Bygg momentum.' },
    ]
  },
  {
    id: 'health',
    name: 'Helse / Trening',
    emoji: '🏥',
    color: '#06b6d4',
    tone: 'Motiverende, faglig og empatisk. Inspirer til endring.',
    audience: 'Helsebevisste, treningsentusiaster, pasienter 20-60 år',
    keywords: 'helse, trening, kosthold, velvære, motivasjon, resultater, livsstil',
    about: 'Vi tilbyr helsetjenester, trening eller velvære-produkter.',
    prompts: [
      { label: 'Treningstips', prompt: 'Del et konkret treningstips med øvelse og forklaring. Motivér.' },
      { label: 'Sukseesshistorie', prompt: 'Del en kundes transformasjonshistorie. Vis resultater og inspirér.' },
      { label: 'Myte vs fakta', prompt: 'Avliv en vanlig helsemyte med fakta. Posisjonér som ekspert.' },
    ]
  },
  {
    id: 'tech',
    name: 'Tech / SaaS',
    emoji: '💻',
    color: '#7c3aed',
    tone: 'Innovativ, klar og løsningsorientert. Vis teknisk kompetanse uten jargong.',
    audience: 'Utviklere, produktledere, gründere, tech-enthusiaster 22-45 år',
    keywords: 'SaaS, startup, AI, automatisering, produktivitet, API, integrasjon',
    about: 'Vi bygger teknologi/software som løser et spesifikt problem.',
    prompts: [
      { label: 'Feature launch', prompt: 'Annonser en ny feature. Vis problemet den løser og hvordan den fungerer.' },
      { label: 'Behind the code', prompt: 'Del en teknisk innsikt eller arkitekturbeslutning. Vis teamets kompetanse.' },
      { label: 'Brukercase', prompt: 'Vis hvordan en kunde bruker produktet og hvilke resultater de oppnår.' },
    ]
  }
]
