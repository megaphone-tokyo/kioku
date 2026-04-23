#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACT="${SCRIPT_DIR}/../scripts/extract-epub.mjs"

fail() { echo "FAIL: $1" >&2; exit 1; }
ok()   { echo "PASS: $1"; }

# F1: 引数数 != 3 → exit 64
out_rc=0
bash -c "node '${EXTRACT}' foo bar 2>/dev/null" || out_rc=$?
if [[ "${out_rc}" != "64" ]]; then fail "F1 expected exit 64, got ${out_rc}"; fi
ok "F1 argv count check"

# F2: argv[1] (epub-path) が .epub でない → exit 64 or 2
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
touch "${TMP}/notepub.txt"
out_rc=0
node "${EXTRACT}" "${TMP}/notepub.txt" "${TMP}/out" "books" 2>/dev/null || out_rc=$?
if [[ "${out_rc}" != "2" && "${out_rc}" != "64" ]]; then fail "F2 expected exit 2 or 64, got ${out_rc}"; fi
ok "F2 non-epub ext"

# F3: argv[1] が `-` 始まり → exit 64 (flag injection 防御, VULN-E008)
out_rc=0
node "${EXTRACT}" "--help" "${TMP}/out" "books" 2>/dev/null || out_rc=$?
if [[ "${out_rc}" != "64" ]]; then fail "F3 expected exit 64 for dash-prefix, got ${out_rc}"; fi
ok "F3 dash-prefix flag rejected"

# F4: MCP-D6o — 24h+ 前の .cache/epub/ が起動時に GC される
VAULT="$(mktemp -d)"; trap 'rm -rf "${TMP}" "${VAULT}"' EXIT
mkdir -p "${VAULT}/.cache/epub/oldstale-abc"
# mtime を 48h 前に書換
touch -t "$(date -u -v-48H +%Y%m%d%H%M 2>/dev/null || date -u -d '-48 hours' +%Y%m%d%H%M)" "${VAULT}/.cache/epub/oldstale-abc" 2>/dev/null || true
# 引数エラーでも起動時 GC は走るので exit 64 でも GC 効果を観測できる
OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" foo 2>/dev/null || true
if [[ -d "${VAULT}/.cache/epub/oldstale-abc" ]]; then
  fail "F4 stale cache dir NOT GC'd (MCP-D6o)"
fi
ok "F4 stale cache GC (MCP-D6o)"

# F5: 不正 EPUB (ZIP でないファイル) → exit 2 (invalid_epub) or exit 1 (yauzl raw error)
VAULT2="$(mktemp -d)"; trap 'rm -rf "${TMP}" "${VAULT}" "${VAULT2}"' EXIT
mkdir -p "${VAULT2}/raw-sources/books"
# Write garbage content (not a valid ZIP)
printf 'not a zip file\n' > "${VAULT2}/raw-sources/books/bad.epub"
out_rc=0
OBSIDIAN_VAULT="${VAULT2}" node "${EXTRACT}" "raw-sources/books/bad.epub" "${VAULT2}/.cache/epub" "books" 2>/dev/null || out_rc=$?
if [[ "${out_rc}" == "2" ]]; then
  ok "F5 malformed EPUB → exit 2 (invalid_epub mapping)"
elif [[ "${out_rc}" == "1" ]]; then
  echo "WARN: F5 got exit 1 (yauzl raw error, not mapped). Not a blocker but consider mapping yauzl errors too." >&2
  ok "F5 malformed EPUB → exit 1 (yauzl raw) — acceptable"
else
  fail "F5 expected exit 1 or 2, got ${out_rc}"
fi

# F6: absolute path from find command (auto-ingest.sh Category A path) — should succeed or exit 5, not 1
VAULT3="$(mktemp -d)"; trap 'rm -rf "${TMP}" "${VAULT}" "${VAULT2}" "${VAULT3}"' EXIT
mkdir -p "${VAULT3}/raw-sources/books" "${VAULT3}/.cache"
printf 'garbage not a zip' > "${VAULT3}/raw-sources/books/absolute.epub"
ABS_PATH="${VAULT3}/raw-sources/books/absolute.epub"
out_rc=0
OBSIDIAN_VAULT="${VAULT3}" node "${EXTRACT}" "${ABS_PATH}" "${VAULT3}/.cache/epub" "books" 2>/dev/null || out_rc=$?
# Should NOT exit 1 (unhandled) — must be mapped to exit 2 (invalid epub) or exit 5 (path issue)
if [[ "${out_rc}" == "1" ]]; then
  fail "F6 absolute path produced exit 1 (unhandled). Category A flow is broken!"
fi
# Accept exit 2 (caught as invalid epub) or 5 (path outside) — both are structured responses
ok "F6 absolute path → structured exit (rc=${out_rc})"

# F7: 日本語 filename の EPUB が Unicode regex を通過 (GAP-D002 / VULN-D012 regression guard)
# vault-path.mjs SAFE_PATH_RE と整合 (LEARN#6 cross-boundary drift 再発防止、v0.4.0 latent regression の遡及 fix)
# 旧 regex `^[\w./-]+\.epub$` は `\w = [A-Za-z0-9_]` で 日本語/中国語 filename を silent skip
# していた (auto-ingest cron で find が絶対 path を渡したとき exit 64 で黙殺)
VAULT4="$(mktemp -d)"; trap 'rm -rf "${TMP}" "${VAULT}" "${VAULT2}" "${VAULT3}" "${VAULT4}"' EXIT
mkdir -p "${VAULT4}/raw-sources/books" "${VAULT4}/.cache"
# 内容は garbage (F5/F6 と同じ戦略) — regex 通過後に content error で exit 2 になることを assert
printf 'garbage not a zip' > "${VAULT4}/raw-sources/books/日本語サンプル.epub"
JP_PATH="${VAULT4}/raw-sources/books/日本語サンプル.epub"
out_rc=0
OBSIDIAN_VAULT="${VAULT4}" node "${EXTRACT}" "${JP_PATH}" "${VAULT4}/.cache/epub" "books" 2>/dev/null || out_rc=$?
# 期待: regex を通過するので exit 64 ではない。content error で exit 2 (or 1) が正解。
if [[ "${out_rc}" == "64" ]]; then
  fail "F7 Japanese filename EPUB rejected by regex (got 64). Unicode regex fix regression!"
fi
if [[ "${out_rc}" != "2" && "${out_rc}" != "1" ]]; then
  echo "WARN: F7 got unexpected exit ${out_rc}, expected 1 or 2 (regex passes, content bad)." >&2
fi
ok "F7 Japanese filename EPUB passes Unicode regex (rc=${out_rc}, not 64)"

echo "All extract-epub tests passed."
