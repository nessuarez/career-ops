// Pure helpers that turn prepared Markdown into plain speakable paragraphs.
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Yields { line, heading: {level,title}|null } skipping fence content (fences are marked).
function scan(md) {
  const out = [];
  let fence = null;
  for (const line of md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const f = line.match(FENCE_RE);
    if (f && (!fence || fence === f[1])) {
      fence = fence ? null : f[1];
      out.push({ line, fenced: true });
    } else if (fence) {
      out.push({ line, fenced: true });
    } else {
      const h = line.match(HEADING_RE);
      out.push({ line, fenced: false, heading: h ? { level: h[1].length, title: h[2].trim() } : null });
    }
  }
  return out;
}

const inline = (s) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(^|\W)_(.+?)_(?=\W|$)/g, '$1$2');

export function cleanMarkdown(md) {
  const lines = [];
  for (const { line, fenced } of scan(md)) {
    if (fenced) continue;
    const t = line.trim();
    if (t.startsWith('|') || /^([-*_])(\s*\1){2,}$/.test(t)) continue;
    lines.push(
      inline(t.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^([-*+]|\d+[.)])\s+/, '')),
    );
  }
  return lines.join('\n');
}

// Text under the heading whose title matches (case-insensitive, trimmed); the title itself is excluded.
export function selectSection(md, title) {
  const items = scan(md);
  const want = title.trim().toLowerCase();
  const start = items.findIndex((i) => i.heading && i.heading.title.toLowerCase() === want);
  if (start < 0) {
    const titles = items.filter((i) => i.heading).map((i) => `${'#'.repeat(i.heading.level)} ${i.heading.title}`);
    throw new Error(`section "${title}" not found; available headings: ${titles.join(' | ') || 'none'}`);
  }
  const level = items[start].heading.level;
  const body = [];
  for (const i of items.slice(start + 1)) {
    if (i.heading && i.heading.level <= level) break;
    body.push(i.line);
  }
  return body.join('\n');
}

// Blank-line separated paragraphs, each on one line, empties dropped.
export function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
}

// Greedy packing of sentences up to max chars; an over-long sentence breaks at whitespace.
export function splitSentences(text, max) {
  const pieces = [];
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    let rest = s;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) pieces.push(rest);
  }
  const out = [];
  for (const p of pieces) {
    if (out.length && out[out.length - 1].length + 1 + p.length <= max) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
