-- Migrasjon + seed: Inspo-bibliotek (HOLO Sesjon J, #6). Kjøres MANUELT i Render Shell.
-- 14 nisjer fra TryHolo, lokalisert no/en/pt-BR. Idempotent (ON CONFLICT).

CREATE TABLE IF NOT EXISTS inspo_niches (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug            TEXT UNIQUE NOT NULL,
  name_no         TEXT, name_en TEXT, name_pt_br TEXT,
  description_no  TEXT, description_en TEXT, description_pt_br TEXT,
  icon            TEXT,
  example_brands  JSONB DEFAULT '[]'::jsonb,
  content_themes  JSONB DEFAULT '[]'::jsonb,
  hashtags        JSONB DEFAULT '[]'::jsonb,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inspo_items (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  niche_id         TEXT NOT NULL REFERENCES inspo_niches(id) ON DELETE CASCADE,
  title            TEXT,
  description      TEXT,
  image_url        TEXT,
  source_url       TEXT,
  platform         TEXT,
  engagement_score INTEGER,
  language         TEXT DEFAULT 'en',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspo_items_niche ON inspo_items (niche_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_saved_inspo (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL,
  inspo_item_id TEXT NOT NULL REFERENCES inspo_items(id) ON DELETE CASCADE,
  notes         TEXT,
  saved_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, inspo_item_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_inspo_user ON user_saved_inspo (user_id, saved_at DESC);

DO $$ BEGIN
  ALTER TABLE user_saved_inspo ADD CONSTRAINT saved_inspo_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN RAISE NOTICE 'saved_inspo user FK hoppet over: %', SQLERRM; END $$;

-- ─── Seed: 14 nisjer ─────────────────────────────────────────────────────────
INSERT INTO inspo_niches (slug, name_no, name_en, name_pt_br, description_no, description_en, description_pt_br, icon, example_brands, content_themes, hashtags) VALUES
('fashion','Mote','Fashion','Moda',
 'Klesmerker, design og personlig stil.','Apparel brands, design and personal style.','Marcas de roupas, design e estilo pessoal.','👗',
 '["Zara","H&M","Nike","Gucci","Levis"]'::jsonb,
 '["Outfit of the day","Behind the seams design process","Capsule wardrobe tips","Seasonal lookbook","Styling one piece three ways","Sustainable fabric story","Customer street style","New drop teaser","Fit guide and sizing","Trend forecast","Founder style story","Care and repair tips"]'::jsonb,
 '["#ootd","#fashion","#style","#outfitinspo","#streetstyle","#sustainablefashion","#lookbook","#newdrop","#wardrobe","#fashiondaily","#styleinspo","#slowfashion","#mensfashion","#womensfashion"]'::jsonb),
('beauty','Skjønnhet','Beauty','Beleza',
 'Hudpleie, sminke og velvære.','Skincare, makeup and grooming.','Cuidados com a pele, maquiagem e bem-estar.','💄',
 '["Sephora","Fenty Beauty","The Ordinary","Glossier","Rare Beauty"]'::jsonb,
 '["Get ready with me","Skincare routine breakdown","Ingredient spotlight","Before and after","Product dupe comparison","Tutorial for one look","Myth busting","Shade matching guide","Founder story","User generated reviews","Seasonal skin tips","Clean beauty explainer"]'::jsonb,
 '["#beauty","#skincare","#makeup","#grwm","#beautytips","#skincareroutine","#makeuptutorial","#cleanbeauty","#glowup","#beautycommunity","#selfcare","#crueltyfree","#makeupinspo","#skintok"]'::jsonb),
('health-wellness','Helse & Velvære','Health & Wellness','Saúde & Bem-estar',
 'Mental og fysisk helse, balanse og vaner.','Mental and physical health, balance and habits.','Saúde mental e física, equilíbrio e hábitos.','🧘',
 '["Calm","Headspace","Whoop","Hims","Athletic Greens"]'::jsonb,
 '["Morning routine","Habit stacking tips","Mindfulness practice","Sleep optimization","Supplement explainer","Myth vs fact","Client transformation","Stress management","Nutrition basics","Expert Q and A","Daily check in prompt","Recovery and rest"]'::jsonb,
 '["#wellness","#health","#mindfulness","#selfcare","#mentalhealth","#healthylifestyle","#wellbeing","#habits","#sleep","#mindset","#holistichealth","#wellnessjourney","#balance","#healthyhabits"]'::jsonb),
('food-beverage','Mat & Drikke','Food & Beverage','Comida & Bebida',
 'Restauranter, oppskrifter og produkter.','Restaurants, recipes and products.','Restaurantes, receitas e produtos.','🍽️',
 '["Starbucks","Oatly","Chipotle","HelloFresh","Innocent"]'::jsonb,
 '["Recipe reel","Behind the kitchen","Ingredient sourcing story","Menu launch","Pairing guide","Quick weeknight meal","Customer favorite","Seasonal special","Founder origin story","How it is made","Taste test","Sustainability story"]'::jsonb,
 '["#food","#foodie","#recipe","#foodporn","#instafood","#homecooking","#foodphotography","#eatlocal","#foodstagram","#yum","#chef","#foodlover","#tasty","#foodreel"]'::jsonb),
('fitness-sports','Trening & Sport','Fitness & Sports','Fitness & Esportes',
 'Trening, prestasjon og sportsutstyr.','Training, performance and sports gear.','Treino, desempenho e equipamentos esportivos.','💪',
 '["Gymshark","Nike Training","Peloton","Strava","Lululemon"]'::jsonb,
 '["Workout of the day","Form check tutorial","Client transformation","Gear review","Mobility routine","Pre and post workout nutrition","Beginner program","Motivation Monday","Athlete spotlight","Common mistakes","Home workout","Progress tracking tips"]'::jsonb,
 '["#fitness","#workout","#gym","#training","#fitfam","#fitnessmotivation","#gymlife","#strengthtraining","#running","#homeworkout","#fitnessjourney","#fitspo","#sports","#getfit"]'::jsonb),
('travel','Reise','Travel','Viagem',
 'Destinasjoner, opplevelser og reisetips.','Destinations, experiences and travel tips.','Destinos, experiencias e dicas de viagem.','✈️',
 '["Airbnb","Booking.com","GoPro","Away","National Geographic"]'::jsonb,
 '["Destination guide","Hidden gems","Packing tips","Budget travel hacks","Day in the trip vlog","Local food to try","Itinerary breakdown","Booking tips","Solo travel safety","Photo spot guide","Sustainable travel","Travel gear essentials"]'::jsonb,
 '["#travel","#travelgram","#wanderlust","#traveltips","#explore","#travelphotography","#vacation","#adventure","#instatravel","#bucketlist","#traveldiaries","#solotravel","#roadtrip","#travelmore"]'::jsonb),
('real-estate','Eiendom','Real Estate','Imoveis',
 'Boligsalg, utleie og eiendomsinvestering.','Home sales, rentals and property investment.','Vendas de imoveis, aluguel e investimento.','🏠',
 '["Zillow","Redfin","Compass","Keller Williams","Sothebys Realty"]'::jsonb,
 '["New listing tour","Just sold celebration","Home staging tips","Market update","First time buyer guide","Neighborhood spotlight","Behind the deal","Renovation before and after","Investment math explainer","Open house invite","Client testimonial","Mortgage basics"]'::jsonb,
 '["#realestate","#realtor","#homesforsale","#property","#justlisted","#dreamhome","#realestateagent","#homebuying","#investmentproperty","#openhouse","#luxuryhomes","#firsttimehomebuyer","#housegoals","#realestateinvesting"]'::jsonb),
('finance-investing','Finans & Investering','Finance & Investing','Financas & Investimentos',
 'Personlig okonomi, investering og fintech.','Personal finance, investing and fintech.','Financas pessoais, investimento e fintech.','📈',
 '["Revolut","Robinhood","Wise","Nubank","Vanguard"]'::jsonb,
 '["Money myth busting","Budgeting framework","Investing basics","Market explainer","Compound interest visual","Client success story","Common money mistakes","Tax tips","Product walkthrough","Q and A on saving","Side income ideas","Financial habit of the week"]'::jsonb,
 '["#finance","#investing","#personalfinance","#money","#financialfreedom","#fintech","#wealth","#investingtips","#moneytips","#stocks","#financialliteracy","#savings","#budgeting","#passiveincome"]'::jsonb),
('technology-saas','Teknologi & SaaS','Technology & SaaS','Tecnologia & SaaS',
 'Programvare, verktoy og B2B-teknologi.','Software, tools and B2B technology.','Software, ferramentas e tecnologia B2B.','💻',
 '["Notion","Slack","Figma","HubSpot","Stripe"]'::jsonb,
 '["Feature launch","Product demo","Customer use case","Founder build in public","Tips and shortcuts","Integration spotlight","Behind the roadmap","Industry hot take","Comparison versus alternative","Onboarding walkthrough","Changelog highlight","Team culture post"]'::jsonb,
 '["#saas","#tech","#startup","#productivity","#software","#b2b","#buildinpublic","#technology","#nocode","#automation","#founders","#producthunt","#devtools","#aitools"]'::jsonb),
('ecommerce-retail','E-handel & Detalj','E-commerce & Retail','E-commerce & Varejo',
 'Nettbutikker, produkter og detaljhandel.','Online stores, products and retail.','Lojas online, produtos e varejo.','🛍️',
 '["Shopify","Amazon","Allbirds","Gymshark","Warby Parker"]'::jsonb,
 '["Product launch","Unboxing experience","Bestseller spotlight","Customer review feature","Behind the brand","Bundle and offer","How to use the product","Restock alert","Founder story","Sustainability angle","Gift guide","Sale countdown"]'::jsonb,
 '["#ecommerce","#shopsmall","#onlineshopping","#smallbusiness","#shopify","#productlaunch","#retail","#dtc","#newarrival","#shopnow","#brand","#unboxing","#giftguide","#sale"]'::jsonb),
('education-coaching','Utdanning & Coaching','Education & Coaching','Educacao & Coaching',
 'Kurs, coaching og kunnskapsdeling.','Courses, coaching and knowledge sharing.','Cursos, coaching e compartilhamento.','🎓',
 '["MasterClass","Coursera","Skillshare","Duolingo","Mindvalley"]'::jsonb,
 '["Free lesson clip","Student success story","Common misconception","Framework explainer","Behind the curriculum","Q and A session","Study tips","Live workshop teaser","Quote and reflection","Day in the coaching life","Tool recommendation","Mini challenge"]'::jsonb,
 '["#education","#coaching","#learning","#onlinelearning","#elearning","#coach","#personaldevelopment","#growthmindset","#study","#mentor","#edutok","#knowledge","#lifecoach","#skills"]'::jsonb),
('professional-services','Profesjonelle tjenester','Professional Services','Servicos Profissionais',
 'Konsulent, juss, regnskap og byraaer.','Consulting, legal, accounting and agencies.','Consultoria, juridico, contabilidade e agencias.','💼',
 '["McKinsey","Deloitte","LegalZoom","Upwork","Fiverr"]'::jsonb,
 '["Client case study","Service explainer","Behind the process","Industry insight","Common client question","Team spotlight","Before and after results","Myth busting","Thought leadership","How we work","Pricing transparency","Tool of the trade"]'::jsonb,
 '["#consulting","#business","#b2b","#professionalservices","#entrepreneur","#agency","#smallbusiness","#leadership","#strategy","#marketing","#freelance","#businesstips","#growth","#clientwork"]'::jsonb),
('automotive','Bil & Motor','Automotive','Automotivo',
 'Biler, motor og kjoretoyskultur.','Cars, motors and vehicle culture.','Carros, motores e cultura automotiva.','🚗',
 '["Tesla","Porsche","BMW","Toyota","Rivian"]'::jsonb,
 '["New model reveal","Test drive review","Behind the build","Detailing tips","Customer delivery","Spec breakdown","Maintenance how to","EV versus combustion","Heritage story","Track day","Comparison video","Accessory spotlight"]'::jsonb,
 '["#cars","#automotive","#carsofinstagram","#carlifestyle","#ev","#carlovers","#auto","#cardealership","#carreview","#luxurycars","#motorsport","#carspotting","#newcar","#driving"]'::jsonb),
('home-lifestyle','Hjem & Livsstil','Home & Lifestyle','Casa & Estilo de Vida',
 'Interior, hjem og hverdagsliv.','Interiors, home and everyday living.','Interiores, casa e vida cotidiana.','🏡',
 '["IKEA","West Elm","Dyson","Article","The Container Store"]'::jsonb,
 '["Room makeover","Before and after","Styling tips","Product in real homes","Organization hacks","Seasonal decor","Founder story","DIY project","Customer home tour","Care and maintenance","Small space ideas","Mood and color guide"]'::jsonb,
 '["#home","#interiordesign","#homedecor","#homeinspo","#interior","#decor","#homestyle","#interiorinspo","#homesweethome","#designinspo","#organization","#cozyhome","#homemakeover","#lifestyle"]'::jsonb)
ON CONFLICT (slug) DO NOTHING;
