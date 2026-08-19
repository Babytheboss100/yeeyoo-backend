const DIMENSION_KEYS = Object.freeze({
  'hook.type': 'hookType',
  format: 'format',
  'cta.type': 'ctaType',
  'visual.first_frame': 'visualFirstFrame',
})

export class MediaInsightsError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message)
    this.name = 'MediaInsightsError'
    this.code = code
    this.status = status
  }
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    const codeName = name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
    throw new MediaInsightsError(`MEDIA_INSIGHTS_${codeName}_REQUIRED`, `${name} is required`)
  }
  return value.trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function emptyDimensions() {
  return { hookType: [], format: [], ctaType: [], visualFirstFrame: [] }
}

// One read-only aggregate query keeps event cardinality in PostgreSQL instead
// of loading raw performance events into the web process. The ownership keys
// are present on both sides of the join intentionally: artifact ids alone are
// not a tenant boundary.
export const GENOME_INSIGHTS_SQL = `
  WITH scoped_events AS (
    SELECT
      e.artifact_id,
      e.kind,
      e.unit,
      e.value,
      a.genome
    FROM marketing_performance_events AS e
    INNER JOIN marketing_artifacts AS a
      ON a.id = e.artifact_id
     AND a.user_id = e.user_id
     AND a.project_id = e.project_id
    WHERE e.user_id = $1
      AND e.project_id = $2
      AND a.user_id = $1
      AND a.project_id = $2
      AND a.genome IS NOT NULL
  ), dimensioned AS (
    SELECT
      scoped_events.artifact_id,
      scoped_events.kind,
      scoped_events.unit,
      scoped_events.value,
      dimensions.dimension,
      dimensions.dimension_value
    FROM scoped_events
    CROSS JOIN LATERAL (VALUES
      ('hook.type', NULLIF(scoped_events.genome #>> '{hook,type}', '')),
      ('format', NULLIF(scoped_events.genome #>> '{format}', '')),
      ('cta.type', NULLIF(scoped_events.genome #>> '{cta,type}', '')),
      ('visual.first_frame', NULLIF(scoped_events.genome #>> '{visual,first_frame}', ''))
    ) AS dimensions(dimension, dimension_value)
    WHERE dimensions.dimension_value IS NOT NULL
  )
  SELECT
    dimension,
    dimension_value,
    kind,
    unit,
    COUNT(*)::integer AS event_count,
    COUNT(DISTINCT artifact_id)::integer AS artifact_count,
    SUM(value)::double precision AS total_value,
    AVG(value)::double precision AS average_value,
    MIN(value)::double precision AS minimum_value,
    MAX(value)::double precision AS maximum_value
  FROM dimensioned
  GROUP BY dimension, dimension_value, kind, unit
  ORDER BY dimension, dimension_value, kind, unit
`

export async function getGenomeInsights({ userId, projectId, db } = {}) {
  const owner = requiredId(userId, 'userId')
  const project = requiredId(projectId, 'projectId')
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('getGenomeInsights requires an injected database client')
  }

  const { rows = [] } = await db.query(GENOME_INSIGHTS_SQL, [owner, project])
  const dimensions = emptyDimensions()

  for (const row of rows) {
    const key = DIMENSION_KEYS[row.dimension]
    if (!key || typeof row.dimension_value !== 'string') continue
    dimensions[key].push({
      value: row.dimension_value,
      kind: row.kind,
      unit: row.unit,
      eventCount: number(row.event_count),
      artifactCount: number(row.artifact_count),
      totalValue: number(row.total_value),
      averageValue: number(row.average_value),
      minimumValue: number(row.minimum_value),
      maximumValue: number(row.maximum_value),
    })
  }

  return {
    schemaVersion: 'yeeyoo.media.insights.v1',
    projectId: project,
    dimensions,
  }
}

export function createGetMediaInsightsHandler({ db, requireProjectImpl, sendErrorImpl } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('media insights handler requires an injected database client')
  }
  if (typeof requireProjectImpl !== 'function') {
    throw new TypeError('media insights handler requires project ownership verification')
  }
  if (typeof sendErrorImpl !== 'function') {
    throw new TypeError('media insights handler requires an injected error responder')
  }

  return async function getMediaInsights(req, res) {
    try {
      const projectId = req.query?.projectId
      await requireProjectImpl(req, projectId, db)
      res.json(await getGenomeInsights({ userId: req.user.id, projectId, db }))
    } catch (error) {
      sendErrorImpl(res, error)
    }
  }
}
