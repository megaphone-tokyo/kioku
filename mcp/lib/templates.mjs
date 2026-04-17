// templates.mjs — wiki ノート用テンプレート (concept / project / decision) の読み込み。
// templates/notes/*.md を frontmatter + body skeleton として返す。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// kioku-mcp が tools/claude-brain/mcp/lib/ にあるので、テンプレは ../../templates/notes/
// 環境変数 KIOKU_TEMPLATES_DIR で上書き可 (テスト用)
function resolveTemplatesDir() {
  if (process.env.KIOKU_TEMPLATES_DIR) {
    return process.env.KIOKU_TEMPLATES_DIR;
  }
  return join(__dirname, '..', '..', 'templates', 'notes');
}

export const VALID_TEMPLATES = new Set(['concept', 'project', 'decision']);

export async function loadTemplate(name) {
  if (!VALID_TEMPLATES.has(name)) {
    throw new Error(`unknown template: ${name}`);
  }
  const path = join(resolveTemplatesDir(), `${name}.md`);
  const content = await readFile(path, 'utf8');
  return parseFrontmatter(content);
}
