import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { canonicalStringify } from '../src/mediaEngine/contracts/workerApi.js'
import { createArtifactVideoInputResolver } from '../src/mediaEngine/genome/videoInputResolver.js'

const PROJECT={schemaVersion:1,kind:'reel',canvas:{width:108,height:192,fps:30,background:'#000'},scenes:[{id:'s1',duration:1,elements:[{id:'clip',type:'video',assetId:'asset-1'}]}],captions:[]}
const sha='a'.repeat(64)
function row(overrides={}){const value={id:'asset-1',user_id:'u1',project_id:'p1',status:'approved',approval_current:true,content:{media:{kind:'video',objectRef:`media/${sha}.mp4`,mimeType:'video/mp4',sha256:sha}},provenance:{jobId:'j1'},checksum_version:'yeeyoo.artifact.content.sha256.v1',output_checksum:sha,...overrides};value.content_checksum=overrides.content_checksum||crypto.createHash('sha256').update(canonicalStringify({content:value.content,provenance:value.provenance})).digest('hex');return value}

test('artifact resolver binds client asset IDs to owner-scoped immutable storage refs',async()=>{let query;const db={query:async(sql,values)=>{query={sql,values};return{rows:[row()]}}};const resolved=await createArtifactVideoInputResolver({db})({userId:'u1',projectId:'p1',input:{project:PROJECT,genomeHints:{campaign:'c1'}}});assert.match(query.sql,/a\.user_id=\$1 AND a\.project_id=\$2/);assert.deepEqual(query.values,['u1','p1',['asset-1']]);assert.deepEqual(resolved.assetBindings['asset-1'],{objectRef:`media/${sha}.mp4`,mimeType:'video/mp4',sha256:sha});assert.equal(resolved.genomeHints.campaign,'c1')})

test('artifact resolver fails closed for missing, foreign, stale and client-supplied refs',async()=>{const missing=createArtifactVideoInputResolver({db:{query:async()=>({rows:[]})}});await assert.rejects(missing({userId:'u1',projectId:'p1',input:{project:PROJECT}}),{code:'VIDEO_ASSET_NOT_AVAILABLE'});const foreign=createArtifactVideoInputResolver({db:{query:async()=>({rows:[row({user_id:'u2'})]})}});await assert.rejects(foreign({userId:'u1',projectId:'p1',input:{project:PROJECT}}),{code:'VIDEO_ASSET_NOT_SUITABLE'});const stale=createArtifactVideoInputResolver({db:{query:async()=>({rows:[row({content_checksum:'b'.repeat(64)})]})}});await assert.rejects(stale({userId:'u1',projectId:'p1',input:{project:PROJECT}}),{code:'STALE_VIDEO_ASSET'});await assert.rejects(missing({userId:'u1',projectId:'p1',input:{project:PROJECT,assetBindings:{'asset-1':{objectRef:'foreign'}}}}),{code:'INVALID_MEDIA_JOB_REQUEST'})})
