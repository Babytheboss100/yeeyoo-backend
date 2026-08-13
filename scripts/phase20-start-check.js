const fail=message=>{throw new Error(`Phase20 backend start refused: ${message}`)}
if(process.env.NODE_ENV!=='test'||process.env.YEEYOO_STRICT_TEST_DB!=='true')fail('strict test environment is required')
if(!process.env.YEEYOO_TEST_DATABASE_URL)fail('explicit test database URL is required')
if(process.env.DATABASE_URL)fail('DATABASE_URL must be unset to prevent inherited production selection')
for(const key of ['FAL_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY','GROK_API_KEY','STRIPE_SECRET_KEY'])if(process.env[key])fail(`${key} must be unset`)
const port=Number(process.env.PORT||3001);if(!Number.isInteger(port)||port<1024||port>65535)fail('PORT must be a non-privileged integer')
console.log(JSON.stringify({ready:true,mode:'strict-test',databaseIdentityRequired:'yeeyoo_phase13_test',port,providers:'disabled'}))

