// frontmatter.mjs — YAML frontmatter の最小サブセット parse / serialize / merge。
// Node 18+ stdlib のみ。Wiki テンプレが使う形式 (フラット key + scalar / array) のみサポート。

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(content) {
  if (typeof content !== 'string') return { data: {}, body: '' };
  const m = content.match(FM_RE);
  if (!m) return { data: {}, body: content };
  return { data: parseSimpleYaml(m[1]), body: content.substring(m[0].length) };
}

export function serializeFrontmatter(data, body = '') {
  const yaml = serializeSimpleYaml(data);
  const bodyClean = body.startsWith('\n') ? body.substring(1) : body;
  return `---\n${yaml}---\n${bodyClean}`;
}

export function mergeFrontmatter(existing, updates) {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (Array.isArray(v) && Array.isArray(existing[k])) {
      const seen = new Set();
      const out = [];
      for (const item of [...existing[k], ...v]) {
        const key = typeof item === 'string' ? item : JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
        }
      }
      merged[k] = out;
    } else if (v !== undefined && v !== null) {
      merged[k] = v;
    } else if (!(k in merged)) {
      merged[k] = v;
    }
  }
  return merged;
}

function parseSimpleYaml(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.substring(0, idx).trim();
    let val = line.substring(idx + 1).trim();
    if (!key) continue;
    // strip inline comment (after space + #)
    const hashIdx = val.indexOf(' #');
    if (hashIdx >= 0 && !isInsideQuotes(val, hashIdx)) {
      val = val.substring(0, hashIdx).trim();
    }
    if (val === '' || val === 'null' || val === '~') {
      out[key] = null;
    } else if (val === 'true') {
      out[key] = true;
    } else if (val === 'false') {
      out[key] = false;
    } else if (/^-?\d+$/.test(val)) {
      out[key] = parseInt(val, 10);
    } else if (/^-?\d+\.\d+$/.test(val)) {
      out[key] = parseFloat(val);
    } else if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      out[key] = inner ? splitYamlList(inner).map(stripQuotes) : [];
    } else {
      out[key] = stripQuotes(val);
    }
  }
  return out;
}

function isInsideQuotes(s, idx) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < idx; i++) {
    if (s[i] === "'" && !inDouble) inSingle = !inSingle;
    else if (s[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

function splitYamlList(inner) {
  // Split by comma at top level, respecting quoted strings
  const out = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of inner) {
    if (ch === ',' && !inSingle && !inDouble) {
      out.push(buf.trim());
      buf = '';
    } else {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2) {
    // Double-quoted: JSON.parse で \uXXXX / \n / \" 等のエスケープを復号する。
    // 復号に失敗する場合 (ill-formed JSON) は安全側で raw slice を返す。
    // JSON double-quoted は YAML double-quoted の厳密なサブセットなので安全。
    if (s[0] === '"' && s[s.length - 1] === '"') {
      try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    // Single-quoted: YAML 単一引用符は単純 (唯一のエスケープは '' → ')。
    if (s[0] === "'" && s[s.length - 1] === "'") {
      return s.slice(1, -1).replace(/''/g, "'");
    }
  }
  return s;
}

function serializeSimpleYaml(data) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}:`);
    } else if (Array.isArray(v)) {
      const items = v.map(yamlScalar).join(', ');
      lines.push(`${k}: [${items}]`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function yamlScalar(v) {
  if (typeof v !== 'string') return String(v);
  if (v === '') return '""';
  if (/[:#\[\]{},&*!|>'"%@`]|^[\s-]|\s$/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}
