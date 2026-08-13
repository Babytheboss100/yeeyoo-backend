import pg from 'pg'
import {seedPhase19Fixture} from '../src/services/phase19Fixture.js'
if(process.env.NODE_ENV!=='test'||process.env.YEEYOO_ENABLE_PHASE19_FIXTURE!=='true'||!process.env.YEEYOO_TEST_DATABASE_URL)throw new Error('Phase19 fixture requires explicit test-only gates')
const pool=new pg.Pool({connectionString:process.env.YEEYOO_TEST_DATABASE_URL,ssl:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:10000})
try{const client=await pool.connect();try{await seedPhase19Fixture(client);console.log(JSON.stringify({seeded:true,fixture:'phase19'}))}finally{client.release()}}finally{await pool.end()}

