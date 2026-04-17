// wiki-context-injector.mjs — SessionStart で wiki/index.md を additionalContext として注入する
//
// Claude Code は Hook の stdout に JSON (`{ "additionalContext": "..." }`) が流れてきたら、
// その内容をシステムプロンプトに追記する。本スクリプトは wiki/index.md を読み取り、
// Karpathy LLM Wiki パターンに従って「作業前に関連ページを Read せよ」という
// 参照ルールと共にプロジェクト情報・Wiki パスを整形して出力する。
//
// 設計原則 (session-logger.mjs と共通):
//   - Node 18+ 組み込みのみ (`fs/promises`, `path`)
//   - 常に exit 0 (フェイルセーフ)
//   - OBSIDIAN_VAULT 未設定 / index.md 不在 / 読み取り失敗 → 何も出力せず exit 0
//
// 参考: tools/claude-brain/plan/26041502_参照の方法をKarpathyに合わせた形に修正.md

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 全エラーを exit 0 に落とすセーフティネット
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

async function main() {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) return;

  const indexPath = join(vault, 'wiki', 'index.md');
  const index = await readFile(indexPath, 'utf-8').catch(() => null);
  if (index === null) return;

  // プロジェクト名は cwd の末尾ディレクトリから推定 (完全一致させる必要はない)
  const cwd = process.cwd();
  const projectName = cwd.split('/').filter(Boolean).pop() || 'unknown';

  const context = [
    '## ナレッジベース (自動注入)',
    '',
    'あなたには過去の作業から蓄積されたナレッジベース (Wiki) があります。',
    '',
    '### ルール',
    '- 作業を開始する前に、以下の目次から現在のタスクに関連しそうなページを特定してください',
    '- 関連しそうなページがあれば、必ず Read ツールで読んでから作業を始めてください',
    '- 該当するページが見つからなければ、そのまま作業を開始してください',
    '- 作業中に有用な分析や比較を生成した場合は、wiki/analyses/ にページとして保存してください',
    '',
    `### 現在のプロジェクト: ${projectName}`,
    `### Wiki パス: $OBSIDIAN_VAULT/wiki/`,
    '',
    '### Wiki 目次',
    index,
  ].join('\n');

  const output = JSON.stringify({ additionalContext: context });
  process.stdout.write(output);
}

main().catch(() => {
  // 念のための二重セーフティ
  process.exit(0);
});
