#!/usr/bin/env bash
# tests/extract-docx.test.sh — scripts/extract-docx.mjs CLI の契約テスト。
# F7a-g: argv + exit code + LEARN#6 absolute path regression
# F8:    起動時 GC (.cache/docx/)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EXTRACT="${REPO_ROOT}/tools/claude-brain/scripts/extract-docx.mjs"
DOCX_BUILDER="${REPO_ROOT}/tools/claude-brain/tests/fixtures/docx-builder.mjs"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
VAULT="${TMP}/vault"
mkdir -p "${VAULT}/raw-sources/papers"
mkdir -p "${VAULT}/.cache/docx"
mkdir -p "${VAULT}/.cache/extracted"

pass=0; fail=0
assert() { if eval "$1"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $2"; fi; }

# --- DOCX fixture 生成 (docx-builder.mjs を node で呼び出し) ---
# NOTE: --input-type=module + `-e` では import の相対 path が process.cwd() 起点になるため
#       絶対 path (file://) で確実に解決する。
NODE_SCRIPT=$(cat <<JS
import { buildDocx } from 'file://${DOCX_BUILDER}';
import { writeFileSync } from 'node:fs';
const out = process.argv[1];
writeFileSync(out, buildDocx());
JS
)
DOCX="${VAULT}/raw-sources/papers/sample.docx"
node --input-type=module -e "${NODE_SCRIPT}" "${DOCX}"
assert "[[ -f '${DOCX}' ]]" "docx fixture generated"

# --- F7a: 引数過不足 ---
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" 2>/dev/null; rc=$?; set -e
assert "[[ ${rc} -eq 64 ]]" "F7a: no-arg exits 64 (got ${rc})"

# --- F7b: leading `-` ---
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "-evil.docx" "${VAULT}/raw-sources" "papers" 2>/dev/null; rc=$?; set -e
assert "[[ ${rc} -eq 64 ]]" "F7b: leading - exits 64"

# --- F7c: .docx 以外 ---
echo "x" > "${VAULT}/raw-sources/papers/foo.txt"
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "${VAULT}/raw-sources/papers/foo.txt" "${VAULT}/raw-sources" "papers" 2>/dev/null; rc=$?; set -e
assert "[[ ${rc} -eq 64 || ${rc} -eq 2 ]]" "F7c: non-.docx rejected (got ${rc})"

# --- F7d: vault 外 ---
OUTSIDE="${TMP}/outside.docx"
cp "${DOCX}" "${OUTSIDE}"
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "${OUTSIDE}" "${VAULT}/raw-sources" "papers" 2>/dev/null; rc=$?; set -e
assert "[[ ${rc} -eq 5 || ${rc} -eq 64 ]]" "F7d: outside vault rejected (got ${rc})"

# --- F7e: max input bytes ---
set +e; OBSIDIAN_VAULT="${VAULT}" KIOKU_DOC_MAX_INPUT_BYTES=10 node "${EXTRACT}" "${DOCX}" "${VAULT}/raw-sources" "papers" 2>/dev/null; rc=$?; set -e
assert "[[ ${rc} -eq 4 ]]" "F7e: exceeds max input exits 4 (got ${rc})"

# --- F7f: 正常系 ---
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "${DOCX}" "${VAULT}/raw-sources" "papers"; rc=$?; set -e
assert "[[ ${rc} -eq 0 ]]" "F7f: valid docx exits 0 (got ${rc})"
assert "[[ -f '${VAULT}/.cache/extracted/docx-papers--sample.md' ]]" "F7f: chunk file created"

# --- F7g: absolute path (from auto-ingest.sh find) — LEARN#6 regression guard ---
# find が出力する absolute path をそのまま extract-docx.mjs に渡して正常動作することを確認
ABS_DOCX="$(cd "$(dirname "${DOCX}")" && pwd)/$(basename "${DOCX}")"
rm -f "${VAULT}/.cache/extracted/docx-papers--sample.md"
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "${ABS_DOCX}" "${VAULT}/raw-sources" "papers"; rc=$?; set -e
assert "[[ ${rc} -eq 0 ]]" "F7g: absolute path from find exits 0 (LEARN#6 regression, got ${rc})"
assert "[[ -f '${VAULT}/.cache/extracted/docx-papers--sample.md' ]]" "F7g: chunk file created from absolute path"

# --- F8: 起動時 GC (.cache/docx/ の 24h+ dir) ---
OLD_DIR="${VAULT}/.cache/docx/stale-$(uuidgen 2>/dev/null || echo 'stale-0000')"
mkdir -p "${OLD_DIR}"
# mtime を 25h 前に設定 (macOS + linux 両対応)
touch -t 202001010000 "${OLD_DIR}" 2>/dev/null || touch -d "25 hours ago" "${OLD_DIR}"
# 引数エラーでも GC は走る (extract-epub.mjs と同パターン)
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" 2>/dev/null; set -e
assert "[[ ! -d '${OLD_DIR}' ]]" "F8: 24h+ .cache/docx/ dir is GC'd on startup"

# --- F9: auto-ingest.sh → extract-docx.mjs → .cache/extracted/ の e2e smoke ---
# LEARN#6 規約: plan template の "real e2e smoke test" default 要件を満たす
# regression guard。auto-ingest.sh の DOCX Category A block (find → node
# scripts/extract-docx.mjs) → handleIngestDocx → .cache/extracted/ の一気通貫を
# KIOKU_DRY_RUN=1 (claude -p は skip、DOCX pre-step は実行) で固定化する。
rm -rf "${VAULT}/.cache/extracted" && mkdir -p "${VAULT}/.cache/extracted"
rm -rf "${VAULT}/.cache/docx" && mkdir -p "${VAULT}/.cache/docx"
E2E_DOCX="${VAULT}/raw-sources/papers/e2e.docx"
# fixture 生成は F7f と同じ NODE_SCRIPT パターンを踏襲 (file:// 絶対 URL import)
E2E_NODE_SCRIPT=$(cat <<JS
import { buildDocx } from 'file://${DOCX_BUILDER}';
import { writeFileSync } from 'node:fs';
const out = process.argv[1];
writeFileSync(out, buildDocx());
JS
)
node --input-type=module -e "${E2E_NODE_SCRIPT}" "${E2E_DOCX}"

# auto-ingest.sh を KIOKU_DRY_RUN=1 で実行 (claude -p は skip、extract-docx.mjs は実行)
set +e
OBSIDIAN_VAULT="${VAULT}" KIOKU_DRY_RUN=1 \
  bash "${REPO_ROOT}/tools/claude-brain/scripts/auto-ingest.sh" > "${TMP}/f9.log" 2>&1
rc=$?
set -e
assert "[[ ${rc} -eq 0 ]]" "F9: auto-ingest.sh dry-run exits 0 (got ${rc})"
assert "[[ -f '${VAULT}/.cache/extracted/docx-papers--e2e.md' ]]" "F9: e2e chunk generated via auto-ingest path"
assert "grep -qE 'UNPROCESSED_SOURCES|Found.*unprocessed|DRY RUN' '${TMP}/f9.log'" "F9: auto-ingest observed ingest state"

# --- F10: 日本語 filename の DOCX が Unicode regex を通過 (GAP-D002 / VULN-D012 regression guard) ---
# vault-path.mjs SAFE_PATH_RE と整合 (LEARN#6 cross-boundary drift 再発防止)
# 旧 regex `^[\w./-]+\.docx$` は `\w = [A-Za-z0-9_]` で 日本語/中国語 filename を silent skip
# していた (auto-ingest cron で find が絶対 path を渡したとき exit 64 で黙殺)
JP_DOCX="${VAULT}/raw-sources/papers/論文サンプル.docx"
cp "${DOCX}" "${JP_DOCX}"
rm -f "${VAULT}/.cache/extracted/docx-papers--論文サンプル.md"
set +e; OBSIDIAN_VAULT="${VAULT}" node "${EXTRACT}" "${JP_DOCX}" "${VAULT}/raw-sources" "papers"; rc=$?; set -e
assert "[[ ${rc} -eq 0 ]]" "F10: Japanese filename DOCX passes Unicode regex + extracts (got ${rc})"
assert "[[ -f '${VAULT}/.cache/extracted/docx-papers--論文サンプル.md' ]]" "F10: Japanese filename chunk file created"

echo "passed: ${pass}  failed: ${fail}"
[[ ${fail} -eq 0 ]]
