// wiki-context-injector.mjs — SessionStart / PostCompact で Wiki コンテキストを注入する
//
// Claude Code v2 の Hook stdout には以下 JSON 構造で流す必要がある:
//   { "hookSpecificOutput": { "hookEventName": "SessionStart" | "PostCompact",
//                             "additionalContext": "..." } }
// この内容がシステムプロンプトに追記される。旧 v1 系の flat `{ "additionalContext": "..." }`
// は v2 の Claude Code CLI には認識されないため、v0.5.1 hotfix で wrapping を導入した。
// 参考 compat: ~/.claude/plugins/cache/claude-plugins-official/vercel/*/hooks/compat.mjs
//
// 本スクリプトは以下 2 つの経路を扱う:
//
//   - SessionStart: wiki/index.md (+ wiki/hot.md があれば) を注入する
//     Karpathy LLM Wiki パターンに従って「作業前に関連ページを Read せよ」
//     という参照ルールと共に整形する (Phase H)
//
//   - PostCompact: wiki/hot.md のみを注入する (v0.5.1 Phase B)
//     context compaction で index.md はすでに context に残存している想定。
//     hot cache (短い引き継ぎメモ) だけを追加して compaction ロスを埋める。
//
// hook_event_name の解決順序:
//   1. stdin から JSON を読み `payload.hook_event_name` を取得 (Claude Code 標準経路)
//   2. `CLAUDE_HOOK_EVENT` 環境変数を fallback 参照 (手動テスト / install-hooks 経路)
//   3. どちらも無ければ SessionStart として扱う (既存挙動を維持)
//
// 設計原則 (session-logger.mjs と共通):
//   - Node 18+ 組み込み + 親リポ内 masking.mjs のみ (外部ネットワーク禁止)
//   - 常に exit 0 (フェイルセーフ)
//   - OBSIDIAN_VAULT 未設定 / 読み取り失敗 → 何も出力せず exit 0
//   - hot.md は `applyMasks()` を通してから注入 (秘密情報の漏れ防御)
//   - hot.md は MAX_HOT_CHARS で truncate (コンテキスト暴発防止)
//   - hot.md の symlink による vault 外 escape を realpath で拒否
//
// 参考:
//   - tools/claude-brain/plan/26041502_参照の方法をKarpathyに合わせた形に修正.md (Phase H)
//   - tools/claude-brain/plan/claude/26042303_feature-roadmap-post-v0-5-0-impl.md §Phase B

import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { maskText as applyMasks } from '../scripts/lib/masking.mjs';

// hot.md 1 ファイル当たりの上限 (文字数)。超えた分は「... (truncated)」で切り詰める。
// 4000 字 ≈ 日本語で 1500〜2000 word、英語で 500〜700 word 相当。
// plan 上の「Recent Context (≤500 words) soft limit」より余裕を持たせた hard cap。
const MAX_HOT_CHARS = 4000;

// index.md 上限 (文字数)。Claude Code v2 の additionalContext は内部 cap (推定 10KB 前後)
// で末尾が truncate される挙動があるため、index.md を 10000 字で切って hot.md を確実に
// 届けるための優先制御。超過時は「... (index.md truncated, read full file with Read tool)」
// を末尾に追加して、LLM 側に省略を明示する。
// 2026-04-23 v0.5.1 hotfix 2 で追加 (dogfooding で KIOKU の index.md が 17KB に肥大し、
// hot.md section が末尾配置のため Claude Code cap で落ちる事象を受けて導入)。
const MAX_INDEX_CHARS = 10000;

// 全エラーを exit 0 に落とすセーフティネット
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function envTruthy(val) {
  if (!val) return false;
  return /^(1|true|yes|on)$/i.test(String(val).trim());
}

function debugLog(msg) {
  if (!envTruthy(process.env.KIOKU_DEBUG)) return;
  process.stderr.write(`[kioku-injector] ${msg}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveHookEvent() {
  const raw = await readStdin();
  if (raw && raw.trim()) {
    try {
      const payload = JSON.parse(raw);
      if (payload && typeof payload.hook_event_name === 'string') {
        return payload.hook_event_name;
      }
    } catch {
      // stdin が非 JSON でも continue (env fallback 経路を生かす)
    }
  }
  const envEvent = process.env.CLAUDE_HOOK_EVENT;
  if (typeof envEvent === 'string' && envEvent.length > 0) return envEvent;
  return 'SessionStart';
}

// hot.md を安全に読み取る:
//   - realpath で vault 配下に閉じていることを確認 (symlink escape 拒否)
//   - ENOENT 等の読み取り失敗は silent skip (existence は任意)
//   - applyMasks で秘密情報パターンを伏字化
//   - MAX_HOT_CHARS で truncate
// 返り値: 注入用文字列 (null = 注入しない)
async function loadHotMd(vault) {
  const hotPath = join(vault, 'wiki', 'hot.md');
  let realVault;
  let realHot;
  try {
    realVault = await realpath(vault);
  } catch {
    return null;
  }
  try {
    realHot = await realpath(hotPath);
  } catch {
    // hot.md が無い場合 (ENOENT) も含めて silent skip
    return null;
  }
  // symlink で vault 外 (/etc/passwd 等) を指していないか検証
  if (realHot !== realVault && !realHot.startsWith(realVault + sep)) {
    debugLog(`hot.md resolves outside vault (rejected): ${realHot}`);
    return null;
  }
  let content;
  try {
    content = await readFile(hotPath, 'utf-8');
  } catch {
    return null;
  }
  content = applyMasks(content);
  if (content.length > MAX_HOT_CHARS) {
    debugLog(`hot.md truncated: ${content.length} > ${MAX_HOT_CHARS} chars`);
    content = content.slice(0, MAX_HOT_CHARS) + '\n\n... (truncated by injector)';
  }
  return content;
}

function buildSessionStartContext({ projectName, index, hot }) {
  const lines = [];
  // ルール + プロジェクト情報は常に先頭 (LLM への指示)
  if (index !== null || hot !== null) {
    lines.push(
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
      '### Wiki パス: $OBSIDIAN_VAULT/wiki/',
    );
  }
  // hot.md を Wiki 目次より前に置く (Claude Code v2 additionalContext cap 対策)
  // hot.md は小さく (≤4000 char) 重要度が高いため先に届くことを優先。
  if (hot !== null) {
    lines.push(
      '',
      '### ホットキャッシュ (wiki/hot.md)',
      '',
      '直近セッションの引き継ぎメモ。優先度の高い作業文脈が書かれている場合があります。',
      '',
      hot,
    );
  }
  // Wiki 目次は末尾 (cap で truncate されても Read tool で直接読めば十分)
  if (index !== null) {
    let indexBody = index;
    if (indexBody.length > MAX_INDEX_CHARS) {
      indexBody = indexBody.slice(0, MAX_INDEX_CHARS)
        + '\n\n... (index.md truncated, read full file with Read tool)';
    }
    lines.push(
      '',
      '### Wiki 目次',
      indexBody,
    );
  }
  return lines.join('\n');
}

function buildPostCompactContext({ hot }) {
  return [
    '## ホットキャッシュ (自動注入 / PostCompact)',
    '',
    '前のセッション context が compaction されました。以下は引き継ぎ用の短いメモです:',
    '',
    hot,
  ].join('\n');
}

async function main() {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) return;

  const event = await resolveHookEvent();
  const hot = await loadHotMd(vault);

  if (event === 'PostCompact') {
    if (hot === null) {
      debugLog('PostCompact: no hot.md, nothing to inject');
      return;
    }
    const context = buildPostCompactContext({ hot });
    debugLog(`PostCompact: injected ${context.length} chars (hot=${hot.length} chars)`);
    // Claude Code v2 schema: hookSpecificOutput は PreToolUse / UserPromptSubmit /
    // PostToolUse の 3 event のみサポート。PostCompact はエントリが無いため
    // validation error で silent 破棄される (2026-04-23 RYU 実機検証で判明)。
    // top-level の `systemMessage` field (全 event 共通、string optional) を使って
    // system prompt に注入する。
    process.stdout.write(JSON.stringify({ systemMessage: context }));
    return;
  }

  // SessionStart (default) 経路: index.md + (hot.md があれば) を注入
  const indexPath = join(vault, 'wiki', 'index.md');
  const index = await readFile(indexPath, 'utf-8').catch(() => null);
  if (index === null && hot === null) return;

  const cwd = process.cwd();
  const projectName = cwd.split('/').filter(Boolean).pop() || 'unknown';
  const context = buildSessionStartContext({ projectName, index, hot });
  debugLog(
    `SessionStart: injected ${context.length} chars (index=${index !== null}, hot=${hot !== null})`,
  );
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }));
}

main().catch(() => {
  process.exit(0);
});
