import crypto from 'node:crypto'
import { canonicalStringify } from '../contracts/workerApi.js'
import { MediaJobError } from '../jobs/errors.js'

const SHA256_RE=/^[a-f0-9]{64}$/
const OBJECT_REF_RE=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/
const CHECKSUM_V1='yeeyoo.artifact.content.sha256.v1'
const LEGACY_CHECKSUM_V1='yeeyoo.artifact.legacy-pg-jsonb.v1'
const MIME_BY_KIND=Object.freeze({image:new Set(['image/png','image/jpeg','image/webp']),video:new Set(['video/mp4']),audio:new Set(['audio/mpeg','audio/wav']),font:new Set(['font/ttf','font/otf'])})

function fail(code='VIDEO_ASSET_NOT_AVAILABLE',message='A referenced video asset is unavailable',status=409){throw new MediaJobError(code,message,{status})}
function contentDigest(row){return crypto.createHash('sha256').update(canonicalStringify({content:row.content,provenance:row.provenance})).digest('hex')}
function safeRefs(project){
  try{
    const refs=[]
    if(!Array.isArray(project.scenes))throw new TypeError()
    for(const scene of project.scenes){
      if(scene?.background&&typeof scene.background==='object')refs.push({kind:'image',ref:scene.background})
      if(!Array.isArray(scene?.elements))throw new TypeError()
      for(const element of scene.elements){if(element?.type==='image'||element?.type==='video')refs.push({kind:element.type,ref:element})}
    }
    if(project.audio?.music)refs.push({kind:'audio',ref:project.audio.music})
    if(project.audio?.voiceover)refs.push({kind:'audio',ref:project.audio.voiceover})
    for(const font of project.fonts||[])refs.push({kind:'font',ref:font})
    return refs
  }catch{return fail('INVALID_MEDIA_JOB_REQUEST','Composer project asset references are invalid',400)}
}

export function createArtifactVideoInputResolver({db}={}){
  if(!db||typeof db.query!=='function')throw new TypeError('db.query is required')
  return async function resolveVideoInput({userId,projectId,input}={}){
    if(!userId||!projectId||!input?.project||typeof input.project!=='object'||Array.isArray(input.project))fail('INVALID_MEDIA_JOB_REQUEST','Video render scope is invalid',400)
    if(input.assetBindings!=null)fail('INVALID_MEDIA_JOB_REQUEST','Client asset bindings are not accepted',400)
    const refs=safeRefs(input.project)
    const byId=new Map()
    for(const ref of refs){
      const id=ref?.ref?.assetId
      if(typeof id!=='string'||!id.trim()||id!==id.trim()||id.length>200)fail('INVALID_MEDIA_JOB_REQUEST','Composer project asset IDs are invalid',400)
      const prior=byId.get(id)
      if(prior&&prior!==ref.kind)fail('VIDEO_ASSET_NOT_SUITABLE','A referenced asset has conflicting media roles')
      byId.set(id,ref.kind)
    }
    if(byId.size===0)return Object.freeze({project:structuredClone(input.project),assetBindings:Object.freeze({}),genomeHints:Object.freeze({...input.genomeHints})})
    const ids=[...byId.keys()]
    const {rows}=await db.query(`SELECT a.id,a.user_id,a.project_id,a.status,a.content,a.provenance,a.checksum_version,a.content_checksum,a.output_checksum,
      (latest.decision='approved' AND latest.checksum_version=a.checksum_version AND latest.content_checksum=a.content_checksum AND latest.output_checksum IS NOT DISTINCT FROM a.output_checksum) AS approval_current
      FROM marketing_artifacts a
      LEFT JOIN LATERAL (
        SELECT d.decision,d.checksum_version,d.content_checksum,d.output_checksum
        FROM marketing_approval_decisions d
        WHERE d.user_id=a.user_id AND d.project_id=a.project_id AND d.artifact_id=a.id
          AND d.artifact_version=a.artifact_version AND d.revoked_at IS NULL
        ORDER BY d.decided_at DESC,d.id DESC LIMIT 1
      ) latest ON TRUE
      WHERE a.user_id=$1 AND a.project_id=$2 AND a.id=ANY($3::text[])`,[userId,projectId,ids])
    if(rows.length!==ids.length)fail()
    const bindings=Object.create(null)
    for(const row of rows){
      const kind=byId.get(row.id),media=row.content?.media
      if(row.user_id!==userId||row.project_id!==projectId||row.status!=='approved'||row.approval_current!==true||!kind||!media||media.kind!==kind)fail('VIDEO_ASSET_NOT_SUITABLE','A referenced asset is not a currently approved media artifact')
      if(!MIME_BY_KIND[kind]?.has(media.mimeType)||typeof media.objectRef!=='string'||!OBJECT_REF_RE.test(media.objectRef)||media.objectRef.includes('..')||media.objectRef.includes('://')||media.objectRef.startsWith('/'))fail('VIDEO_ASSET_NOT_SUITABLE','A referenced asset has invalid storage metadata')
      if(!SHA256_RE.test(media.sha256||'')||row.output_checksum!==media.sha256||!SHA256_RE.test(row.content_checksum||''))fail('STALE_VIDEO_ASSET','A referenced asset checksum is stale')
      if(kind==='font'&&refChecksum(input.project,row.id)!==media.sha256)fail('STALE_VIDEO_ASSET','A referenced font checksum is stale')
      if(row.checksum_version===CHECKSUM_V1&&contentDigest(row)!==row.content_checksum)fail('STALE_VIDEO_ASSET','A referenced artifact content changed after it was sealed')
      if(row.checksum_version!==CHECKSUM_V1&&row.checksum_version!==LEGACY_CHECKSUM_V1)fail('STALE_VIDEO_ASSET','A referenced artifact checksum version is unsupported')
      bindings[row.id]=Object.freeze({objectRef:media.objectRef,mimeType:media.mimeType,sha256:media.sha256})
    }
    if(Object.keys(bindings).length!==ids.length)fail()
    return Object.freeze({project:structuredClone(input.project),assetBindings:Object.freeze(bindings),genomeHints:Object.freeze({...input.genomeHints})})
  }
}

function refChecksum(project,assetId){return (project.fonts||[]).find(font=>font?.assetId===assetId)?.sha256}
