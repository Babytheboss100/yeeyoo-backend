import puppeteer from 'puppeteer'

let browser = null

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
  }
  return browser
}

const PLATFORM_ICONS = {
  linkedin: '💼',
  facebook: '📘',
  instagram: '📸',
  twitter: '🐦',
  email: '📧',
}

function buildTemplate(text, platform, projectName) {
  const icon = PLATFORM_ICONS[platform?.toLowerCase()] || '📝'
  const safeText = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  // Truncate for visual layout
  const displayText = safeText.length > 400 ? safeText.substring(0, 397) + '...' : safeText
  const fontSize = displayText.length > 250 ? 26 : displayText.length > 150 ? 30 : 36

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px;
    font-family: 'Inter', -apple-system, sans-serif;
    background: linear-gradient(145deg, #0a0e27 0%, #1a1145 35%, #0d1b3e 70%, #06081a 100%);
    color: #fff;
    display: flex; flex-direction: column;
    padding: 72px;
    position: relative;
    overflow: hidden;
  }

  /* Decorative glow orbs */
  .orb1 {
    position: absolute; top: -120px; right: -80px;
    width: 400px; height: 400px; border-radius: 50%;
    background: radial-gradient(circle, rgba(124,58,237,.25) 0%, transparent 70%);
  }
  .orb2 {
    position: absolute; bottom: -100px; left: -60px;
    width: 350px; height: 350px; border-radius: 50%;
    background: radial-gradient(circle, rgba(45,91,227,.2) 0%, transparent 70%);
  }

  .platform-badge {
    display: inline-flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12);
    border-radius: 100px; padding: 10px 22px;
    font-size: 15px; font-weight: 600; color: rgba(255,255,255,.7);
    letter-spacing: 0.5px; text-transform: capitalize;
    backdrop-filter: blur(8px);
    margin-bottom: 40px;
  }
  .platform-icon { font-size: 20px; }

  .content-area {
    flex: 1; display: flex; align-items: center;
    position: relative; z-index: 1;
  }
  .content-text {
    font-size: ${fontSize}px;
    font-weight: 600;
    line-height: 1.5;
    color: #f0f4ff;
    word-wrap: break-word;
    text-shadow: 0 2px 20px rgba(0,0,0,.3);
  }

  .bottom-bar {
    display: flex; justify-content: space-between; align-items: flex-end;
    position: relative; z-index: 1;
  }

  .project-tag {
    background: rgba(124,58,237,.2); border: 1px solid rgba(124,58,237,.3);
    border-radius: 8px; padding: 8px 18px;
    font-size: 14px; font-weight: 600; color: rgba(168,85,247,.9);
  }

  .brand {
    display: flex; align-items: center; gap: 10px;
  }
  .brand-logo {
    font-size: 28px; font-weight: 800;
    background: linear-gradient(135deg, #2d5be3, #7c3aed);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .brand-sub {
    font-size: 11px; color: rgba(255,255,255,.35);
    letter-spacing: 1px; font-weight: 600;
  }

  /* Subtle grid pattern */
  .grid-bg {
    position: absolute; inset: 0; z-index: 0;
    background-image:
      linear-gradient(rgba(255,255,255,.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.015) 1px, transparent 1px);
    background-size: 60px 60px;
  }
</style>
</head>
<body>
  <div class="orb1"></div>
  <div class="orb2"></div>
  <div class="grid-bg"></div>

  <div class="platform-badge">
    <span class="platform-icon">${icon}</span>
    ${platform || 'Social'}
  </div>

  <div class="content-area">
    <div class="content-text">${displayText}</div>
  </div>

  <div class="bottom-bar">
    <div>${projectName ? `<div class="project-tag">${projectName.replace(/</g, '&lt;')}</div>` : ''}</div>
    <div class="brand">
      <div>
        <div class="brand-logo">yeeyoo</div>
        <div class="brand-sub">AI-GENERERT INNHOLD</div>
      </div>
    </div>
  </div>
</body>
</html>`
}

/**
 * Render a branded social media image as PNG base64
 * @returns {string} data:image/png;base64,... URL
 */
export async function renderBrandedImage(text, platform, projectName) {
  const html = buildTemplate(text, platform, projectName)
  const b = await getBrowser()
  const page = await b.newPage()

  try {
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 8000 })

    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1080 } })
    return `data:image/png;base64,${buf.toString('base64')}`
  } finally {
    await page.close()
  }
}

/**
 * Render with a hard timeout. Returns null if it takes too long.
 */
export async function renderBrandedImageSafe(text, platform, projectName, timeoutMs = 10000) {
  return Promise.race([
    renderBrandedImage(text, platform, projectName),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

// Graceful cleanup
process.on('exit', () => { if (browser) browser.close().catch(() => {}) })
