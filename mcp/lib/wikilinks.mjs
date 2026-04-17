// wikilinks.mjs — Obsidian 形式 [[<title>]] の検出と冪等追記。

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const RELATED_HEADING_RE = /^##\s+関連ページ\s*$/m;

export function findWikilinks(content) {
  if (typeof content !== 'string') return [];
  const out = new Set();
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.add(target);
  }
  return Array.from(out);
}

export function hasWikilink(content, target) {
  return findWikilinks(content).includes(target);
}

export function appendRelatedLink(content, target) {
  if (!target) return content;
  if (hasWikilink(content, target)) return content;
  const linkLine = `- [[${target}]]`;
  if (RELATED_HEADING_RE.test(content)) {
    return content.replace(
      /(##\s+関連ページ\s*\n)([\s\S]*?)(?=\n##\s|\n*$)/,
      (_match, heading, body) => {
        const trimmed = body.replace(/\n+$/, '');
        const sep = trimmed ? trimmed + '\n' : '';
        return `${heading}${sep}${linkLine}\n`;
      },
    );
  }
  const tail = content.endsWith('\n') ? '' : '\n';
  return `${content}${tail}\n## 関連ページ\n\n${linkLine}\n`;
}
