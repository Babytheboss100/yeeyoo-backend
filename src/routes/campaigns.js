import { Router } from 'express';
import { auth } from '../middleware/auth.js';

const r = Router();
r.use(auth);

const TRACKER_URL = process.env.TRACKER_URL || 'https://help-tracker.onrender.com';
const TRACKER_KEY = process.env.TRACKER_API_KEY;

async function tracker(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'x-api-key': TRACKER_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${TRACKER_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tracker ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// POST /api/campaigns — create campaign via help-tracker
r.post('/', async (req, res) => {
  if (!TRACKER_KEY) return res.status(503).json({ error: 'TRACKER_API_KEY ikke konfigurert' });

  const { name, subject, html_body, recipients, scheduled_at } = req.body;
  if (!name || !subject || !html_body) {
    return res.status(400).json({ error: 'name, subject og html_body er påkrevd' });
  }

  try {
    // Parse recipients: comma-separated string or array
    let recipientList = recipients;
    if (typeof recipients === 'string') {
      recipientList = recipients.split(',').map(e => e.trim()).filter(Boolean);
    }

    const campaign = await tracker('/campaigns', 'POST', {
      name,
      subject,
      html_body,
      recipients: recipientList || [],
      scheduled_at: scheduled_at || null,
    });

    res.json(campaign);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/campaigns — list all campaigns with stats
r.get('/', async (req, res) => {
  if (!TRACKER_KEY) return res.status(503).json({ error: 'TRACKER_API_KEY ikke konfigurert' });

  try {
    const campaigns = await tracker('/campaigns');

    // Enrich with stats
    const enriched = await Promise.all(
      campaigns.map(async (c) => {
        try {
          const stats = await tracker(`/stats/campaign/${c.id}`);
          return { ...c, stats };
        } catch {
          return { ...c, stats: null };
        }
      })
    );

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/campaigns/:id — single campaign with full stats
r.get('/:id', async (req, res) => {
  if (!TRACKER_KEY) return res.status(503).json({ error: 'TRACKER_API_KEY ikke konfigurert' });

  try {
    const [campaign, stats] = await Promise.all([
      tracker(`/campaigns/${req.params.id}`),
      tracker(`/stats/campaign/${req.params.id}`),
    ]);
    res.json({ ...campaign, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns/:id/send — trigger sending
r.post('/:id/send', async (req, res) => {
  if (!TRACKER_KEY) return res.status(503).json({ error: 'TRACKER_API_KEY ikke konfigurert' });

  try {
    const result = await tracker(`/campaigns/${req.params.id}/send`, 'POST');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default r;
