// Yeeyoo Radar — RSS/Atom-parsing + polling (HOLO Sesjon J, #7).
// Regex-basert parser (ingen cheerio-dep, samme stil som brand-dna scrape).

import crypto from 'crypto'
import { pool } from '../db.js'
import { safeCrawl } from '../services/safeCrawler.js'

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim()
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decode(m[1]) : null
}
function atomLink(block) {
  const m = block.match(/<link[^>]*href=["']([^"']+)["']/i)
  return m ? m[1] : null
}
function toDate(s) {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t)
}

// Keyword → Google News RSS-søk (gratis, ingen API-nøkkel).
export function keywordFeedUrl(keyword, lang = 'no') {
  const hl = lang === 'pt-BR' ? 'pt-BR' : lang === 'en' ? 'en-US' : 'no'
  const gl = lang === 'pt-BR' ? 'BR' : lang === 'en' ? 'US' : 'NO'
  return `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=${hl}&gl=${gl}`
}

export async function fetchAndParseFeed(url, crawlOptions) {
  const { body: xml } = await safeCrawl(url, { ...crawlOptions, allowedTypes: ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'] })
  const head = xml.split(/<item|<entry/i)[0]
  const feedTitle = tag(head, 'title')

  const items = []
  const re = /<(item|entry)[\s\S]*?<\/\1>/gi
  let m
  while ((m = re.exec(xml))) {
    const b = m[0]
    const link = tag(b, 'link') || atomLink(b)
    const summaryRaw = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')
    const item = {
      title: tag(b, 'title'),
      link,
      summary: summaryRaw ? summaryRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) : null,
      publishedAt: toDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated')),
      guid: tag(b, 'guid') || tag(b, 'id') || link,
    }
    if (item.guid || item.link) items.push(item)
  }
  return { feedTitle, items }
}

// Hent feed, lagre nye items (ON CONFLICT skip), lag notification for nye treff.
// Returnerer antall nye items.
export async function ingestFeed(feed) {
  const { items } = await fetchAndParseFeed(feed.url)
  let added = 0
  for (const it of items.slice(0, 50)) {
    const guid = it.guid || it.link
    if (!guid) continue
    const { rowCount } = await pool.query(
      `INSERT INTO radar_items (id, feed_id, user_id, title, link, summary, guid, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [crypto.randomUUID(), feed.id, feed.user_id, it.title, it.link, it.summary, guid, it.publishedAt]
    )
    if (rowCount > 0) added++
  }
  await pool.query('UPDATE radar_feeds SET last_fetched_at = NOW() WHERE id=$1', [feed.id])

  if (added > 0) {
    const label = feed.keyword ? `keyword "${feed.keyword}"` : (feed.title || 'feed')
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, message, type, link)
       VALUES ($1,$2,$3,$4,'radar','/dashboard/radar')`,
      [crypto.randomUUID(), feed.user_id, 'Nye Radar-treff', `${added} nye treff for ${label}.`]
    ).catch(() => {})
  }
  return added
}

// Poll alle aktive feeds (kalles av daglig scheduler i index.js eller manuelt).
export async function refreshAllActiveFeeds() {
  const { rows } = await pool.query('SELECT * FROM radar_feeds WHERE active = TRUE')
  let total = 0
  for (const feed of rows) {
    try { total += await ingestFeed(feed) } catch (e) { console.error('[radar] feed feilet', feed.id, e.message) }
  }
  console.log(`[radar] poll ferdig: ${total} nye items fra ${rows.length} feeds`)
  return total
}
