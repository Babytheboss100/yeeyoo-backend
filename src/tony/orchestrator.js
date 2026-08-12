import crypto from 'node:crypto'
import { TONY_PERMISSION, TonyToolError } from './toolRegistry.js'

const ALLOWED_FLOW = Object.freeze([
  'marketing_profile.read',
  'competitors.read',
  'copy.create_draft',
  'planner.create_draft',
])

export function untrustedEvidence(value, maxLength = 12_000) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  return Object.freeze({ trust: 'untrusted_external_data', content: text.slice(0, maxLength) })
}

export function assertSafeToolOutput(output, projectId) {
  if (!output || typeof output !== 'object') throw new TonyToolError('INVALID_TOOL_OUTPUT', 'Tool output must be structured')
  if (output.projectId && output.projectId !== projectId) throw new TonyToolError('CROSS_PROJECT_OUTPUT', 'Tool returned another project context')
  if (output.status && ['approved', 'published', 'sent', 'connected', 'deleted'].includes(output.status)) throw new TonyToolError('UNSAFE_TOOL_OUTPUT', 'Draft orchestration produced a privileged side effect')
  if (output.spend || output.providerPostId || output.sentAt) throw new TonyToolError('UNSAFE_TOOL_OUTPUT', 'Draft orchestration produced a privileged side effect')
  return output
}

// Fixed server-owned workflow. Model/browser input can provide campaign intent,
// but can never select tools or elevate permissions.
export async function orchestrateTonyDraft({ registry, context, intent = {}, now = () => new Date().toISOString(), traceId = crypto.randomUUID() }) {
  if (!context?.userId || !context?.projectId) throw new TonyToolError('PROJECT_CONTEXT_REQUIRED', 'Authenticated project context is required')
  const safeContext = Object.freeze({ userId: context.userId, projectId: context.projectId, permissions: [TONY_PERMISSION.CREATE_DRAFT] })
  const trace = { id: traceId, projectId: context.projectId, permission: TONY_PERMISSION.CREATE_DRAFT, startedAt: now(), tools: [], inputArtifactVersions: [], outputs: [], jobIds: [] }
  const invoke = async (name, input = {}) => {
    if (!ALLOWED_FLOW.includes(name)) throw new TonyToolError('ORCHESTRATION_TOOL_DENIED', 'Tool is outside the draft workflow')
    const startedAt = now()
    const output = assertSafeToolOutput(await registry.invoke(name, safeContext, input), context.projectId)
    trace.tools.push({ name, permission: name.endsWith('.read') ? TONY_PERMISSION.READ : TONY_PERMISSION.CREATE_DRAFT, startedAt, finishedAt: now() })
    if (output.version != null) trace.inputArtifactVersions.push({ tool: name, version: output.version })
    if (output.jobId) trace.jobIds.push(output.jobId)
    if (output.id) trace.outputs.push({ tool: name, id: output.id, status: output.status || null })
    return output
  }

  const profile = await invoke('marketing_profile.read')
  const competitors = await invoke('competitors.read')
  const copy = await invoke('copy.create_draft', { intent, marketingProfileVersion: profile.version, competitorIds: competitors.items?.map((item) => item.id) || [] })
  const plan = await invoke('planner.create_draft', { intent, copyArtifactId: copy.id, marketingProfileVersion: profile.version })
  trace.completedAt = now()
  return { profile, competitors, copy, plan, trace, draftOnly: true }
}
