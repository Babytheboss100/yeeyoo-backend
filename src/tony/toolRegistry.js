export const TONY_PERMISSION = Object.freeze({ READ: 'READ', CREATE_DRAFT: 'CREATE_DRAFT', APPROVE: 'APPROVE', PUBLISH: 'PUBLISH' })
const RANK = Object.freeze({ READ: 0, CREATE_DRAFT: 1, APPROVE: 2, PUBLISH: 3 })

export class TonyToolError extends Error {
  constructor(code, message) { super(message); this.name = 'TonyToolError'; this.code = code }
}

export function createTonyToolRegistry(definitions = []) {
  const tools = new Map()
  for (const tool of definitions) {
    if (!tool?.name || !(tool.permission in RANK) || typeof tool.execute !== 'function' || tools.has(tool.name)) throw new TypeError('Invalid or duplicate Tony tool')
    tools.set(tool.name, Object.freeze({ ...tool }))
  }
  return Object.freeze({
    describe() { return [...tools.values()].map(({ name, permission, description = '' }) => ({ name, permission, description })) },
    async invoke(name, context, input = {}, authorization = {}) {
      const tool = tools.get(name)
      if (!tool) throw new TonyToolError('TOOL_NOT_FOUND', 'Tony capability is unavailable')
      if (!context?.userId || !context?.projectId) throw new TonyToolError('PROJECT_CONTEXT_REQUIRED', 'Tony requires an authenticated project context')
      // permissions must be supplied by the authenticated server context. Never
      // trust a requested permission from model/tool input or the browser.
      const granted = Array.isArray(context.permissions) ? context.permissions : [TONY_PERMISSION.READ]
      if (!granted.some((permission) => permission in RANK && RANK[permission] >= RANK[tool.permission])) throw new TonyToolError('PERMISSION_DENIED', `Capability requires ${tool.permission}`)
      if ([TONY_PERMISSION.APPROVE, TONY_PERMISSION.PUBLISH].includes(tool.permission)) {
        if (authorization.confirmed !== true || authorization.confirmationId !== input.confirmationId) throw new TonyToolError('EXPLICIT_CONFIRMATION_REQUIRED', 'Explicit matching confirmation is required')
      }
      return tool.execute(Object.freeze({ userId: context.userId, projectId: context.projectId }), input)
    },
  })
}

export function createDefaultTonyRegistry(handlers = {}) {
  const definition = (name, permission, description) => ({ name, permission, description, execute: handlers[name] || (async () => { throw new TonyToolError('TOOL_NOT_CONFIGURED', 'Capability is not configured') }) })
  return createTonyToolRegistry([
    definition('marketing_profile.read', TONY_PERMISSION.READ, 'Read canonical marketing context'),
    definition('competitors.read', TONY_PERMISSION.READ, 'Read competitor intelligence'),
    definition('seo.read', TONY_PERMISSION.READ, 'Read SEO reports'),
    definition('radar.read', TONY_PERMISSION.READ, 'Read Radar signals'),
    definition('copy.create_draft', TONY_PERMISSION.CREATE_DRAFT, 'Create copy without publishing'),
    definition('planner.create_draft', TONY_PERMISSION.CREATE_DRAFT, 'Create a draft plan'),
    definition('queue.approve', TONY_PERMISSION.APPROVE, 'Approve a queued artifact'),
    definition('queue.publish', TONY_PERMISSION.PUBLISH, 'Publish an approved artifact'),
  ])
}
