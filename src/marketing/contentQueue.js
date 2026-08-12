export function buildContentQueueQuery({ userId, status, projectId, platform }) {
  let sql = 'SELECT p.*, pr.name as project_name, pr.color as project_color FROM posts p LEFT JOIN projects pr ON p.project_id=pr.id WHERE p.user_id=$1'
  const params = [userId]
  if (status) { params.push(status); sql += ` AND p.status=$${params.length}` }
  if (projectId) { params.push(projectId); sql += ` AND p.project_id=$${params.length}` }
  if (platform && platform !== 'all') { params.push(platform); sql += ` AND p.platform=$${params.length}` }
  sql += ' ORDER BY p.created_at DESC LIMIT 100'
  return { sql, params }
}
