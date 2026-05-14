// bases-renderer.mjs — Internal `.base` (Obsidian Bases plugin format) parser + renderer.
//
// Sprint 4 Phase 1 PR A (plan/claude/26051301_v0-9-phase1-impl-plan.md §「PR A」 L147-1068).
//
// Scope (v0.9 P0 7 項目 + P1 warning, codex strategic doc 260513 Axis 1):
//   - filters.and with file.inFolder("path") / file.ext == "ext" / file.name == "X"
//     / negation !expr / <frontmatter_key> == "X" / formula.<name> <op> N
//   - formulas.age_days: '(now() - file.mtime).days'
//   - properties.<name>.displayName: "Label"
//   - views: [{ type: table | list, name, limit, filters, order, groupBy }]
//   - Unknown expression → P1 warning + exclude from view (silent misrender 禁止)
//
// Security boundary (P1, Sprint 3 継承 + LEARN#13):
//   - NO dynamic code execution (no eval / vm / Function constructor).
//   - Filters / formulas are evaluated by a structured switch / table-driven dispatch.
//   - page.body NEVER touched (Sprint 3 body 漏洩契約継承). walkPages is invoked with
//     withBody:false. RenderedView pages only expose rel/name/type/title/frontmatter/mtime/computed.
//   - regex literals avoid invisible Unicode (no U+2028 / U+2029 / U+200B / U+FEFF).

import { walkPages } from './wiki-walker.mjs';

export class BasesParseError extends Error {
  constructor(message, line) {
    super(`${message}${line != null ? ` (line ${line})` : ''}`);
    this.name = 'BasesParseError';
    this.line = line;
  }
}

export function parseBaseFile(text) {
  const warnings = [];
  if (typeof text !== 'string') {
    throw new BasesParseError('parseBaseFile expects a string');
  }
  const raw = parseYamlLike(text);
  const ast = {
    filters: null,
    formulas: {},
    properties: {},
    views: [],
  };
  if (raw && typeof raw === 'object') {
    if (raw.filters != null) {
      if (typeof raw.filters !== 'object' || !raw.filters.and) {
        throw new BasesParseError('filters must contain "and" key');
      }
      if (!Array.isArray(raw.filters.and)) {
        throw new BasesParseError('filters.and must be a list');
      }
      ast.filters = { and: raw.filters.and };
    }
    if (raw.formulas && typeof raw.formulas === 'object') {
      ast.formulas = raw.formulas;
    }
    if (raw.properties && typeof raw.properties === 'object') {
      ast.properties = raw.properties;
    }
    if (Array.isArray(raw.views)) {
      ast.views = raw.views.map((v) => normalizeView(v));
    }
  }
  return { ast, warnings };
}

function normalizeView(v) {
  if (!v || typeof v !== 'object') {
    throw new BasesParseError('view entry must be a mapping');
  }
  const out = {
    type: typeof v.type === 'string' ? v.type : 'list',
    name: typeof v.name === 'string' ? v.name : '',
  };
  if (typeof v.limit === 'number') out.limit = v.limit;
  if (v.filters && typeof v.filters === 'object' && Array.isArray(v.filters.and)) {
    out.filters = { and: v.filters.and };
  }
  if (Array.isArray(v.order)) out.order = v.order;
  if (v.groupBy && typeof v.groupBy === 'object' && typeof v.groupBy.property === 'string') {
    out.groupBy = {
      property: v.groupBy.property,
      direction: v.groupBy.direction === 'DESC' ? 'DESC' : 'ASC',
    };
  }
  return out;
}

export async function renderBases(vault, ast, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const warnings = [];
  if (typeof vault !== 'string' || !vault) {
    return { views: [], warnings };
  }
  const pages = await walkPages(vault, {
    subDir: 'wiki',
    withFrontmatter: true,
    withWikilinks: false,
    withBody: false,
    withMtime: true,
  });

  // Compute formulas first — filters can reference page.computed.<name>.
  for (const p of pages) {
    p.computed = computeFormulas(p, ast, now, warnings);
  }

  // Apply global filters (filters.and).
  let filtered = pages;
  if (ast.filters && Array.isArray(ast.filters.and)) {
    filtered = filtered.filter((p) =>
      ast.filters.and.every((expr) => evaluateFilter(expr, p, ast, now, warnings)),
    );
  }

  const views = [];
  for (const view of ast.views) {
    let vp = filtered;
    if (view.filters && Array.isArray(view.filters.and)) {
      vp = vp.filter((p) =>
        view.filters.and.every((expr) => evaluateFilter(expr, p, ast, now, warnings)),
      );
    }
    vp = applyOrder(vp, view.order);
    const rendered = {
      name: view.name,
      type: view.type,
      pages: [],
    };
    if (view.groupBy) {
      const groups = applyGroupBy(vp, view.groupBy);
      rendered.groupBy = view.groupBy;
      rendered.groups = (groups || []).map((g) => ({
        key: g.key,
        pages: g.pages.map(normalizeRenderedPage),
      }));
      rendered.pages = applyLimit(vp, view.limit).map(normalizeRenderedPage);
    } else {
      rendered.pages = applyLimit(vp, view.limit).map(normalizeRenderedPage);
    }
    views.push(rendered);
  }
  return { views, warnings };
}

// P1 Security boundary (Sprint 3 継承): RenderedView pages must NOT expose `abs`
// (absolute filesystem path) — that would leak local filesystem layout when shell
// templates serialize the view to inline JSON downstream. Whitelist the contract
// fields explicitly so a future walkPages addition cannot accidentally widen the
// surface.
function normalizeRenderedPage(p) {
  return {
    rel: p.rel,
    name: p.name,
    type: p.type,
    title: p.title,
    frontmatter: p.frontmatter || {},
    mtime: p.mtime instanceof Date ? p.mtime : null,
    computed: p.computed || {},
  };
}

// ---------------------------------------------------------------------------
// Filter evaluation (Task A-3): 6 P0 operators + unknown → warning.
// ---------------------------------------------------------------------------

function evaluateFilter(expr, page, ast, now, warnings) {
  if (typeof expr !== 'string') {
    warnings.push(`unknown filter expression: ${JSON.stringify(expr)}`);
    return false;
  }
  const trimmed = expr.trim();

  // 1. Negation: !inner
  if (trimmed.startsWith('!')) {
    return !evaluateFilter(trimmed.slice(1).trim(), page, ast, now, warnings);
  }

  // 2. file.inFolder("path")
  let m = trimmed.match(/^file\.inFolder\("([^"]+)"\)$/);
  if (m) {
    const folder = m[1];
    if (folder === 'wiki') return true;
    if (folder.startsWith('wiki/')) {
      const sub = folder.slice('wiki/'.length);
      if (sub === '') return true;
      return page.rel === sub || page.rel.startsWith(`${sub}/`);
    }
    return false;
  }

  // 3. file.ext == "X"
  m = trimmed.match(/^file\.ext\s*==\s*"([^"]+)"$/);
  if (m) {
    const ext = m[1];
    return page.rel.endsWith(`.${ext}`);
  }

  // 4. file.name == "X"
  m = trimmed.match(/^file\.name\s*==\s*"([^"]+)"$/);
  if (m) {
    return page.name === m[1];
  }

  // 5. formula.<name> <op> N
  m = trimmed.match(/^formula\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const fname = m[1];
    const op = m[2];
    const rhs = Number(m[3]);
    const lhs = (page.computed || {})[fname];
    if (typeof lhs !== 'number') return false;
    switch (op) {
      case '>': return lhs > rhs;
      case '<': return lhs < rhs;
      case '>=': return lhs >= rhs;
      case '<=': return lhs <= rhs;
      case '==': return lhs === rhs;
      default: return false;
    }
  }

  // 6. <frontmatter_key> == "X"   (matches single identifier, not file.* / formula.*)
  m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]+)"$/);
  if (m) {
    const key = m[1];
    const expected = m[2];
    if (key === 'file' || key === 'formula') {
      // shouldn't happen — covered above — but fall through to unknown
    } else {
      const value = page.frontmatter && page.frontmatter[key];
      return value === expected;
    }
  }

  warnings.push(`unknown filter expression: ${trimmed}`);
  return false;
}

// ---------------------------------------------------------------------------
// Formula evaluation (Task A-4): age_days only (P0).
// ---------------------------------------------------------------------------

function computeFormulas(page, ast, now, warnings) {
  const out = {};
  if (!ast.formulas) return out;
  for (const [name, expr] of Object.entries(ast.formulas)) {
    const value = evaluateFormula(expr, page, now);
    if (value === null && !isKnownFormula(expr)) {
      if (Array.isArray(warnings)) {
        warnings.push(`unknown formula expression: ${name}: ${expr}`);
      }
    }
    out[name] = value;
  }
  return out;
}

const AGE_DAYS_RE = /^\(now\(\)\s*-\s*file\.mtime\)\.days$/;

function isKnownFormula(expr) {
  if (typeof expr !== 'string') return false;
  return AGE_DAYS_RE.test(expr.trim());
}

function evaluateFormula(expr, page, now) {
  if (typeof expr !== 'string') return null;
  const trimmed = expr.trim();
  if (AGE_DAYS_RE.test(trimmed)) {
    if (!(page.mtime instanceof Date)) return null;
    const diffMs = now.getTime() - page.mtime.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Order / limit / groupBy (Task A-6).
// ---------------------------------------------------------------------------

function resolveField(page, field) {
  if (field === 'file.name') return page.name;
  if (field === 'file.mtime') return page.mtime;
  if (field === 'file.rel') return page.rel;
  if (typeof field === 'string' && field.startsWith('formula.')) {
    return (page.computed || {})[field.slice('formula.'.length)];
  }
  return page.frontmatter ? page.frontmatter[field] : undefined;
}

function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function applyOrder(pages, orderFields) {
  if (!Array.isArray(orderFields) || orderFields.length === 0) return pages;
  return [...pages].sort((a, b) => {
    for (const field of orderFields) {
      const cmp = compareValues(resolveField(a, field), resolveField(b, field));
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function applyLimit(pages, limit) {
  if (typeof limit !== 'number' || limit < 0) return pages;
  return pages.slice(0, limit);
}

function applyGroupBy(pages, groupBy) {
  if (!groupBy || !groupBy.property) return null;
  const groupsMap = new Map();
  for (const p of pages) {
    const raw = resolveField(p, groupBy.property);
    const key = raw == null ? '(unknown)' : String(raw);
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(p);
  }
  const direction = groupBy.direction === 'DESC' ? -1 : 1;
  return Array.from(groupsMap.entries())
    .sort(([a], [b]) => {
      if (a < b) return -1 * direction;
      if (a > b) return 1 * direction;
      return 0;
    })
    .map(([key, items]) => ({ key, pages: items }));
}

// ---------------------------------------------------------------------------
// Mini YAML-subset parser (Task A-2).
//
// Supports:
//   - 2-space indent (any consistent indent, derived from indent jumps)
//   - key: value  (string, number, boolean, null, single/double-quoted string)
//   - lists: '- item' (string) or '- key: value' (object, additional sub-keys
//     allowed at deeper indent)
//   - nested objects (key: with empty value, then deeper indented block)
//   - comments (# until end of line) and blank lines
//   - keys may contain literal dots (e.g., formula.age_days)
//
// Does NOT support:
//   - YAML anchors / aliases
//   - flow style ({} / [])
//   - multi-line scalars (folded / literal)
//   - tags
// Throws BasesParseError on malformed input.
// ---------------------------------------------------------------------------

function parseYamlLike(text) {
  const rawLines = text.split('\n');
  const lines = rawLines.map((line, idx) => ({
    raw: line,
    lineNum: idx + 1,
  }));

  let i = 0;

  function skipBlank() {
    while (i < lines.length) {
      const trimmed = lines[i].raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        i++;
        continue;
      }
      return;
    }
  }

  function getIndent(line) {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }

  function parseScalar(raw, lineNum) {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (trimmed[0] === '"') {
      if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== '"') {
        throw new BasesParseError(`unterminated double-quoted string: ${trimmed}`, lineNum);
      }
      return trimmed.slice(1, -1);
    }
    if (trimmed[0] === "'") {
      if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== "'") {
        throw new BasesParseError(`unterminated single-quoted string: ${trimmed}`, lineNum);
      }
      return trimmed.slice(1, -1);
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null' || trimmed === '~') return null;
    return trimmed;
  }

  // Find first non-blank colon outside quotes (keys cannot contain unquoted colons).
  function findKeyColon(content) {
    let inSingle = false;
    let inDouble = false;
    let inParen = 0;
    for (let idx = 0; idx < content.length; idx++) {
      const ch = content[idx];
      if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (!inSingle && !inDouble) {
        if (ch === '(') inParen++;
        else if (ch === ')') inParen--;
        else if (ch === ':' && inParen === 0) return idx;
      }
    }
    return -1;
  }

  function parseBlock(parentIndent) {
    const out = {};
    while (i < lines.length) {
      skipBlank();
      if (i >= lines.length) break;
      const { raw, lineNum } = lines[i];
      const ind = getIndent(raw);
      if (ind <= parentIndent) break;
      const content = raw.slice(ind);
      if (content.startsWith('- ') || content === '-') {
        throw new BasesParseError(
          `unexpected list item where mapping expected: "${content}"`,
          lineNum,
        );
      }
      const colonIdx = findKeyColon(content);
      if (colonIdx === -1) {
        throw new BasesParseError(`expected ":" in "${content}"`, lineNum);
      }
      const key = content.slice(0, colonIdx).trim();
      const rest = content.slice(colonIdx + 1).trim();
      i++;
      if (rest === '') {
        // Look at next non-blank line to decide list vs object vs null.
        const savedI = i;
        skipBlank();
        if (i < lines.length) {
          const childInd = getIndent(lines[i].raw);
          if (childInd > ind) {
            const peek = lines[i].raw.slice(childInd);
            if (peek.startsWith('- ') || peek === '-') {
              out[key] = parseList(ind);
            } else {
              out[key] = parseBlock(ind);
            }
            continue;
          }
        }
        i = savedI;
        out[key] = null;
      } else {
        out[key] = parseScalar(rest, lineNum);
      }
    }
    return out;
  }

  function parseList(parentIndent) {
    const out = [];
    while (i < lines.length) {
      skipBlank();
      if (i >= lines.length) break;
      const { raw, lineNum } = lines[i];
      const ind = getIndent(raw);
      if (ind <= parentIndent) break;
      const content = raw.slice(ind);
      if (!content.startsWith('- ') && content !== '-') break;
      const rest = content === '-' ? '' : content.slice(2);
      const itemBodyIndent = ind + 2;
      i++;
      if (rest === '') {
        // Item value is on subsequent indented lines.
        const savedI = i;
        skipBlank();
        if (i < lines.length) {
          const childInd = getIndent(lines[i].raw);
          if (childInd > ind) {
            const peek = lines[i].raw.slice(childInd);
            if (peek.startsWith('- ') || peek === '-') {
              out.push(parseList(ind));
            } else {
              out.push(parseBlock(ind));
            }
            continue;
          }
        }
        i = savedI;
        out.push(null);
        continue;
      }
      const restColonIdx = findKeyColon(rest);
      if (restColonIdx !== -1) {
        const key = rest.slice(0, restColonIdx).trim();
        const valuePart = rest.slice(restColonIdx + 1).trim();
        const obj = {};
        if (valuePart === '') {
          // Look at sub-lines deeper than itemBodyIndent for nested value of this key.
          const savedI = i;
          skipBlank();
          if (i < lines.length) {
            const childInd = getIndent(lines[i].raw);
            if (childInd > itemBodyIndent) {
              const peek = lines[i].raw.slice(childInd);
              if (peek.startsWith('- ') || peek === '-') {
                obj[key] = parseList(itemBodyIndent);
              } else {
                obj[key] = parseBlock(itemBodyIndent);
              }
            } else {
              obj[key] = null;
              i = savedI;
            }
          } else {
            obj[key] = null;
          }
        } else {
          obj[key] = parseScalar(valuePart, lineNum);
        }
        // Continue collecting sibling keys at itemBodyIndent.
        while (i < lines.length) {
          const savedI = i;
          skipBlank();
          if (i >= lines.length) break;
          const nextRaw = lines[i].raw;
          const nextInd = getIndent(nextRaw);
          if (nextInd !== itemBodyIndent) {
            i = savedI;
            break;
          }
          const nextContent = nextRaw.slice(nextInd);
          if (nextContent.startsWith('- ') || nextContent === '-') {
            i = savedI;
            break;
          }
          const sub = parseBlock(itemBodyIndent - 1);
          Object.assign(obj, sub);
          break;
        }
        out.push(obj);
      } else {
        out.push(parseScalar(rest, lineNum));
      }
    }
    return out;
  }

  // Top-level block starts at indent -1 (anything ≥ 0 counts).
  return parseBlock(-1);
}

// ---------------------------------------------------------------------------
// Test-only exports.
// ---------------------------------------------------------------------------

export const _internals = {
  evaluateFilter,
  evaluateFormula,
  computeFormulas,
  applyOrder,
  applyLimit,
  applyGroupBy,
  resolveField,
  parseYamlLike,
};
