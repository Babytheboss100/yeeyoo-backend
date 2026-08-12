const ALLOWED_PLATFORMS = new Set(['linkedin', 'instagram', 'facebook', 'tiktok', 'x'])

export function normalizeRequestedPlatforms(value) {
  if (!Array.isArray(value) || !value.length) return ['linkedin', 'instagram', 'facebook', 'tiktok']
  const unique = [...new Set(value.map((item) => String(item).toLowerCase()).filter((item) => ALLOWED_PLATFORMS.has(item)))]
  if (!unique.length) throw new TypeError('Ingen støttede plattformer valgt')
  return unique
}

export function buildPlannerCalendarQuery({ userId, projectId, startDate, endDate, businessId }) {
  const params = [userId, startDate, endDate]
  let sql = `SELECT p.*, b.name as business_name, b.industry as business_industry,
    COALESCE(p.scheduled_at,p.created_at) as calendar_date FROM posts p
    LEFT JOIN businesses b ON p.business_id=b.id WHERE p.user_id=$1
    AND COALESCE(p.scheduled_at,p.created_at) BETWEEN $2 AND $3`
  if (projectId) { params.push(projectId); sql += ` AND p.project_id=$${params.length}` }
  if (businessId) { params.push(businessId); sql += ` AND p.business_id=$${params.length}` }
  sql += ' ORDER BY COALESCE(p.scheduled_at,p.created_at) ASC'
  return { sql, params }
}
