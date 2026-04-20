// lock.mjs — Vault 書き込み用 advisory lockfile。
// fs.open(.., 'wx') を使った排他作成 + TTL stale 検知。
// auto-ingest.sh / write_wiki / delete が同時に Vault を触っても破損しない。
//
// v0.3.5 追加:
//   `.kioku-summary-<key>.lock` — detached claude -p の tracking 用 (排他ではなく観測用)。
//   auto-ingest.sh は `.kioku-summary-*.lock` を無視するため、`.kioku-mcp.lock` とは
//   別経路で運用される。詳細: plan/claude/26042004_feature-v0-3-5-early-return-design.md

import { open, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 100;
// 機能 2.1 (論点 β): auto-ingest.sh が最大 30 分 lockfile を保持する可能性があるため、
// 10 秒 → 60 秒に延長。Desktop からの write_note は 60 秒待っても成功しない場合は
// LockTimeoutError を throw してクライアントへ明示通知する。
const ACQUIRE_TIMEOUT_MS = 60_000;
const LOCK_FILENAME = '.kioku-mcp.lock';

export class LockTimeoutError extends Error {
  constructor(message = 'lock acquire timeout') {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'lock_timeout';
  }
}

export async function withLock(vault, fn, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
  const lockPath = join(vault, LOCK_FILENAME);
  const start = Date.now();
  let handle;

  while (true) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > ttlMs) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new LockTimeoutError();
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch {}
    try { await unlink(lockPath); } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Summary-specific lockfile (v0.3.5 Option B)
// ---------------------------------------------------------------------------
// detached claude -p の PID と開始時刻を記録するための観測用ファイル。
// 排他目的ではない (auto-ingest.sh は `.kioku-summary-*.lock` を無視する)。
// 目的:
//   - どの PDF が現在背景で要約中かを運用者が確認できる (cron ログ / ls)
//   - 次回 MCP 呼び出しで同じ PDF に対して重複 spawn を避ける判定材料
//   - claude -p が異常終了した際の forensic 情報
// キー規則: `<subdirPrefix>--<stem>` (ingest-pdf.mjs の chunk 命名と整合)
// TTL: 30 分 (claude -p の最大実行時間想定)。auto-ingest が stale を拾って掃除する.

const SUMMARY_LOCK_PREFIX = '.kioku-summary-';
const SUMMARY_LOCK_SUFFIX = '.lock';

export function summaryLockPath(vault, key) {
  if (typeof key !== 'string' || !key.length) {
    throw new Error('summaryLockPath: key required');
  }
  return join(vault, `${SUMMARY_LOCK_PREFIX}${key}${SUMMARY_LOCK_SUFFIX}`);
}

/**
 * detached claude の PID を記録する。同じ key に対して複数回呼ばれた場合は
 * 最新の PID / timestamp で上書きする (次回 read 時に古い情報を返さないため)。
 *
 * @param {string} vault - Vault root (絶対パス)
 * @param {string} key - `<subdirPrefix>--<stem>` 形式の識別子
 * @param {number} pid - detached 子プロセスの PID
 * @returns {Promise<string>} 書き出した lockfile の絶対パス
 */
export async function writeSummaryLock(vault, key, pid) {
  const lockPath = summaryLockPath(vault, key);
  const body = `${pid}\n${new Date().toISOString()}\n`;
  // mode 0o600 (owner r/w) — lockfile は secret を含まないが Vault 既定に合わせる
  await writeFile(lockPath, body, { mode: 0o600 });
  return lockPath;
}
