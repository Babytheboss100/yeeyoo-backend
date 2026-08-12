import { pool } from '../db.js'

export class ProjectAccessError extends Error {
  constructor(message = 'Prosjekt ikke funnet') {
    super(message)
    this.name = 'ProjectAccessError'
    this.status = 404
    this.code = 'PROJECT_NOT_FOUND'
  }
}

// Canonical tenant boundary. Returning 404 avoids disclosing whether another
// user's project exists. Routes must call this before using a supplied projectId.
export async function requireProject(req, projectId, db = pool) {
  if (!req?.user?.id) {
    const error = new ProjectAccessError('Ikke autentisert')
    error.status = 401
    error.code = 'UNAUTHENTICATED'
    throw error
  }
  if (!projectId || typeof projectId !== 'string') {
    const error = new ProjectAccessError('projectId kreves')
    error.status = 400
    error.code = 'PROJECT_REQUIRED'
    throw error
  }
  const { rows } = await db.query(
    'SELECT * FROM projects WHERE id=$1 AND user_id=$2 LIMIT 1',
    [projectId, req.user.id]
  )
  if (!rows[0]) throw new ProjectAccessError()
  return rows[0]
}

export function sendProjectError(res, error) {
  if (!(error instanceof ProjectAccessError)) return false
  res.status(error.status).json({ error: error.message, code: error.code })
  return true
}

export async function enforceProjectOwnership(req, res, next) {
  const projectId = req.body?.projectId || req.body?.project_id || req.query?.projectId
  if (!projectId) return next()
  try {
    req.project = await requireProject(req, projectId)
    next()
  } catch (error) {
    if (!sendProjectError(res, error)) next(error)
  }
}
