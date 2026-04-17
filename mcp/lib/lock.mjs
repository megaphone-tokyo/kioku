// lock.mjs — Vault 書き込み用 advisory lockfile。
// fs.open(.., 'wx') を使った排他作成 + TTL stale 検知。
// auto-ingest.sh / write_wiki / delete が同時に Vault を触っても破損しない。

import { open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const ACQUIRE_TIMEOUT_MS = 10_000;
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
