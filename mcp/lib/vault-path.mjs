// vault-path.mjs — Vault 境界の realpath ガード。
// MCP の write/delete/read で path traversal / symlink 脱出 / 絶対パス指定を遮断する。

import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

// 日本語・中国語・韓国語・その他の Unicode Letter を許可する (write-note.mjs の
// makeSlug が \p{L} を保持するのと整合させるため)。
// \p{L} = Unicode Letter property、\p{N} = Number property。
// path traversal "." とパス区切り "/" は明示的に許可集合に入っており、
// realpath + prefix containment (resolveWithinBase 参照) で escape を遮断する。
const SAFE_PATH_RE = /^[\p{L}\p{N}/._ -]+$/u;
const MAX_PATH_LEN = 512;

export class PathBoundaryError extends Error {
  constructor(message, code = 'path_outside_boundary') {
    super(message);
    this.name = 'PathBoundaryError';
    this.code = code;
  }
}

function validateRelative(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new PathBoundaryError('path must be a non-empty string', 'invalid_path');
  }
  if (rel.length > MAX_PATH_LEN) {
    throw new PathBoundaryError('path too long', 'invalid_path');
  }
  if (rel.includes('\0')) {
    throw new PathBoundaryError('path contains null byte', 'invalid_path');
  }
  if (isAbsolute(rel)) {
    throw new PathBoundaryError('path must be relative', 'absolute_path');
  }
  if (!SAFE_PATH_RE.test(rel)) {
    throw new PathBoundaryError('path contains unsafe characters', 'invalid_path');
  }
  const normalized = normalize(rel);
  if (normalized === '..' || normalized.startsWith('..' + sep) || normalized.includes(sep + '..' + sep)) {
    throw new PathBoundaryError('path escapes parent', 'path_traversal');
  }
}

async function realpathWithFallback(target) {
  try {
    return await realpath(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // ファイル未存在時 (write の create で正常)。親を辿って realpath し、未存在の末尾を結合し直す。
    const tail = [];
    let cur = target;
    while (true) {
      const idx = cur.lastIndexOf(sep);
      if (idx <= 0) {
        throw new PathBoundaryError('path resolution failed (no existing ancestor)', 'invalid_path');
      }
      tail.unshift(cur.substring(idx + 1));
      cur = cur.substring(0, idx);
      try {
        const real = await realpath(cur);
        return join(real, ...tail);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
}

async function resolveWithinBase(vault, subdir, rel) {
  validateRelative(rel);
  let baseAbs;
  try {
    baseAbs = await realpath(join(vault, subdir));
  } catch (err) {
    throw new PathBoundaryError(`base directory not found: ${subdir}`, 'base_missing');
  }
  const candidate = join(baseAbs, rel);
  const resolved = await realpathWithFallback(candidate);
  if (resolved !== baseAbs && !resolved.startsWith(baseAbs + sep)) {
    throw new PathBoundaryError('path outside boundary', 'path_outside_boundary');
  }
  return resolved;
}

export async function assertInsideWiki(vault, rel) {
  return resolveWithinBase(vault, 'wiki', rel);
}

export async function assertInsideSessionLogs(vault, rel) {
  return resolveWithinBase(vault, 'session-logs', rel);
}

export async function assertInsideArchive(vault, rel) {
  return resolveWithinBase(vault, 'wiki/.archive', rel);
}
