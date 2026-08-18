// The reply text of an Anthropic response, joined from every text block.
//
// content[0] is not reliably the answer: current models put a thinking block
// first, so reading index 0 yields undefined on a perfectly successful call.
// Taking every text block also keeps a split reply whole rather than silently
// returning only its first part.
//
// Always returns a string, so callers can trim and test it without guarding.
export function anthropicText(body) {
  const blocks = Array.isArray(body?.content) ? body.content : []
  return blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('')
}
