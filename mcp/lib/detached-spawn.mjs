// detached-spawn.mjs — 親 MCP プロセスが終了しても生き残る子プロセス起動ヘルパ
//
// v0.3.5 Option B (early return + detached claude -p) 用の基盤。
// Claude Desktop の MCPB extension 呼び出しは MCP SDK の 60s hardcoded timeout で
// 切断される (LocalMcpManager.callTool が timeout option を渡さないため) ので、
// 長時間処理 (PDF 要約 1-3 分) は背景で動かして MCP handler は早期 return する。
//
// 設計書: plan/claude/26042004_feature-v0-3-5-early-return-design.md §実装詳細
// 議事録: plan/claude/26042003_meeting_v0-3-5-option-b-decision.md
//
// 使い方:
//   const pid = await spawnDetached('claude', ['-p', prompt, ...], {
//     logFile: `${vault}/.cache/claude-summary-<key>.log`,
//     env: buildChildEnv({ KIOKU_NO_LOG: '1', KIOKU_MCP_CHILD: '1', OBSIDIAN_VAULT: vault }),
//     cwd: vault,
//   });
//
// 注意点:
//   - detached: true + child.unref() で親の event loop から切り離す。
//     どちらか一方だけでは不十分 (detached のみだと親が exit 時に子も終了する場合あり、
//     unref のみだと親は待たないが子が親と同じ process group にいるため SIGHUP を受ける).
//   - stdio: stdin は 'ignore'、stdout/stderr は logFile に redirect。parent の
//     MCP stdio (JSON-RPC framing) を汚染しない。
//   - spawn 失敗 (ENOENT / EACCES 等) は 'error' event で非同期に通知される。
//     setImmediate で 1 tick 待ってから error の有無を判定する。
//   - env は caller 側で buildChildEnv() 等で allowlist filter 済であること。
//     未指定時は process.env がそのまま渡る (default は caller 責務で明示推奨)。

import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 親プロセスから切り離された子プロセスを起動する。
 *
 * @param {string} cmd - 実行コマンド (絶対パス推奨)
 * @param {string[]} args - コマンド引数
 * @param {object} opts
 * @param {string} opts.logFile - stdout/stderr の redirect 先 (絶対パス、append モード)
 * @param {Record<string,string>} [opts.env] - 子の env (caller 側で allowlist filter 済)
 * @param {string} [opts.cwd] - 子の cwd
 * @returns {Promise<number>} 子の PID
 * @throws {Error} logFile パス不正 / spawn 失敗 (ENOENT / EACCES)
 */
export async function spawnDetached(cmd, args, opts = {}) {
  if (!opts.logFile || typeof opts.logFile !== 'string') {
    throw new Error('spawnDetached: opts.logFile (string) is required');
  }

  // logFile の親ディレクトリを作成 (0o700 権限)。既存ならスキップ。
  await mkdir(dirname(opts.logFile), { recursive: true, mode: 0o700 });

  // 追記モードで開く。複数回 spawn された場合も前のログを保持する。
  // 0o600: owner read/write のみ (secrets がログに混じった場合の保護)。
  const logFile = await open(opts.logFile, 'a', 0o600);

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: false,
    });

    // spawn の失敗 (ENOENT / EACCES) は 'error' event で非同期通知される。
    // setImmediate で 1 tick 待って error を観測する。pid が付いていなければ失敗扱い。
    const pid = await new Promise((resolve, reject) => {
      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      setImmediate(() => {
        if (settled) return;
        if (!child.pid) {
          settled = true;
          reject(new Error(`spawnDetached: spawn failed, no pid for ${cmd}`));
          return;
        }
        settled = true;
        resolve(child.pid);
      });
    });

    // 親 event loop から切り離す (これが無いと親が child 終了まで待つ)。
    // pid が確定した後に unref しないと、unref 済みの child に対する error event
    // が観測できない可能性がある。
    child.unref();
    return pid;
  } finally {
    // 子に fd を dup 済なので親側の FileHandle は close してよい。
    await logFile.close();
  }
}
