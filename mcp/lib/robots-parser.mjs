// robots-parser.mjs — robots.txt 最小限パーサ
//
// 仕様参考: https://datatracker.ietf.org/doc/html/rfc9309
// User-agent / Disallow / Allow のみサポート。Crawl-delay 等は無視。

export function parseRobotsTxt(text) {
  const groups = [];
  let currentAgents = [];
  let currentRules = [];
  const lines = text.split(/\r?\n/);
  const flush = () => {
    if (currentAgents.length > 0) {
      groups.push({ agents: currentAgents, rules: currentRules });
    }
    currentAgents = [];
    currentRules = [];
  };
  let lastDirectiveWasAgent = false;
  for (let rawLine of lines) {
    const hashIdx = rawLine.indexOf('#');
    if (hashIdx !== -1) rawLine = rawLine.slice(0, hashIdx);
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (directive === 'user-agent') {
      if (!lastDirectiveWasAgent && currentRules.length > 0) flush();
      currentAgents.push(value.toLowerCase());
      lastDirectiveWasAgent = true;
    } else if (directive === 'disallow') {
      currentRules.push({ type: 'disallow', path: value });
      lastDirectiveWasAgent = false;
    } else if (directive === 'allow') {
      currentRules.push({ type: 'allow', path: value });
      lastDirectiveWasAgent = false;
    }
  }
  flush();
  return { groups };
}

export function isAllowed(rules, userAgent, path) {
  const ua = userAgent.toLowerCase();
  const matching = rules.groups.filter((g) => g.agents.some((a) => a === ua));
  const wildcardGroups = rules.groups.filter((g) => g.agents.some((a) => a === '*'));
  const selectedGroups = matching.length > 0 ? matching : wildcardGroups;
  if (selectedGroups.length === 0) return true;
  const allRules = selectedGroups.flatMap((g) => g.rules);
  let best = null;
  for (const rule of allRules) {
    if (!rule.path) continue;
    if (pathMatches(path, rule.path)) {
      if (!best || rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.type === 'allow')) {
        best = rule;
      }
    }
  }
  if (!best) return true;
  return best.type === 'allow';
}

// blue M-4 fix (2026-04-20): RFC9309 / Google 仕様の `*` wildcard と `$`
// end-of-path anchor をサポート。wildcard 不支持時は `Disallow: /*.pdf$` 等が
// silent-allow になって fail-open の policy 逸脱を起こしていた。
//
// シンプルに pattern を正規表現に変換:
//   `*` → `.*`
//   末尾の `$` → `$` (end-of-path anchor)
//   その他の正規表現メタ文字 → エスケープ
//
// 動作は prefix match の superset なので wildcard を含まない既存 pattern は
// 従来通り prefix 一致する。
function pathMatches(path, pattern) {
  if (!pattern.includes('*') && !pattern.endsWith('$')) {
    // fast path: 従来の prefix match (既存の挙動を維持)
    return path.startsWith(pattern);
  }
  try {
    let regexSrc = '^';
    let p = pattern;
    const hasEndAnchor = p.endsWith('$') && !p.endsWith('\\$');
    if (hasEndAnchor) p = p.slice(0, -1);
    for (const ch of p) {
      if (ch === '*') {
        regexSrc += '.*';
      } else {
        regexSrc += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    if (hasEndAnchor) regexSrc += '$';
    const re = new RegExp(regexSrc);
    return re.test(path);
  } catch {
    // 不正な pattern (想定外) は fail-closed: match 扱いにして
    // 呼び出し元で deny 側に寄せる。URL を叩くより保守的に skip するほうが安全。
    return true;
  }
}
