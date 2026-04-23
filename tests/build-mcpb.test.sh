#!/usr/bin/env bash
#
# build-mcpb.test.sh — scripts/build-mcpb.sh のスモークテスト (Phase N)
#
# 実行: bash tools/claude-brain/tests/build-mcpb.test.sh
#
# 検証項目:
#   MCPB1  --help が usage を表示
#   MCPB2  unknown 引数で exit 1
#   MCPB3  --validate が schema 検証に成功する
#   MCPB4  --dry-run で staging が組み立てられ、必要なファイルが揃う
#   MCPB5  --clean で build/ と dist/ が削除される
#   MCPB6  manifest.json が "name": "kioku-wiki" を含む
#   MCPB7  manifest.json が user_config.vault_path (type=directory, required) を持つ
#   MCPB8  manifest.json が server.mcp_config.env.OBSIDIAN_VAULT 置換を持つ
#
# ネットワークアクセス:
#   --validate は npx 経由で `@anthropic-ai/mcpb` を起動するため、初回はキャッシュ
#   ダウンロードが発生する。CI で skip したい場合は KIOKU_SKIP_MCPB_NETWORK=1 を設定する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BUILD_SCRIPT="${REPO_ROOT}/tools/claude-brain/scripts/build-mcpb.sh"
MANIFEST="${REPO_ROOT}/tools/claude-brain/mcp/manifest.json"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  ok  $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  NG  $1" >&2
}

assert_eq() {
  if [[ "$1" == "$2" ]]; then
    pass "$3"
  else
    fail "$3 (expected=$1, actual=$2)"
  fi
}

assert_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then
    pass "$3"
  else
    fail "$3 (substring not found: $2)"
  fi
}

# -----------------------------------------------------------------------------
# MCPB1: --help prints usage
# -----------------------------------------------------------------------------
echo "== MCPB1: --help =="
set +e
out=$(bash "${BUILD_SCRIPT}" --help 2>&1)
rc=$?
set -e
assert_eq "0" "${rc}" "MCPB1 exit code is 0"
assert_contains "${out}" "build-mcpb.sh" "MCPB1 mentions script name"
assert_contains "${out}" "--dry-run" "MCPB1 documents --dry-run"

# -----------------------------------------------------------------------------
# MCPB2: unknown argument exits 1
# -----------------------------------------------------------------------------
echo "== MCPB2: unknown argument =="
set +e
out=$(bash "${BUILD_SCRIPT}" --not-a-real-flag 2>&1)
rc=$?
set -e
assert_eq "1" "${rc}" "MCPB2 exit code is 1"
assert_contains "${out}" "unknown argument" "MCPB2 reports unknown argument"

# -----------------------------------------------------------------------------
# MCPB3: --validate succeeds against the bundled mcpb CLI
# -----------------------------------------------------------------------------
if [[ "${KIOKU_SKIP_MCPB_NETWORK:-0}" == "1" ]]; then
  echo "== MCPB3: --validate (skipped: KIOKU_SKIP_MCPB_NETWORK=1) =="
else
  echo "== MCPB3: --validate =="
  set +e
  out=$(bash "${BUILD_SCRIPT}" --validate 2>&1)
  rc=$?
  set -e
  assert_eq "0" "${rc}" "MCPB3 exit code is 0"
  assert_contains "${out}" "Manifest schema validation passes" "MCPB3 manifest validates"
fi

# -----------------------------------------------------------------------------
# MCPB4: --dry-run builds staging and lists tree
# -----------------------------------------------------------------------------
echo "== MCPB4: --dry-run =="
set +e
out=$(bash "${BUILD_SCRIPT}" --dry-run 2>&1)
rc=$?
set -e
assert_eq "0" "${rc}" "MCPB4 exit code is 0"
assert_contains "${out}" "[stage] copying manifest" "MCPB4 stages manifest"
assert_contains "${out}" "[stage] copying server code" "MCPB4 stages server code"
assert_contains "${out}" "would run: npx" "MCPB4 prints would-be pack command"

STAGING="${REPO_ROOT}/tools/claude-brain/mcp/build/staging"
[[ -f "${STAGING}/manifest.json" ]] && pass "MCPB4 staging manifest exists" \
  || fail "MCPB4 staging manifest missing"
[[ -f "${STAGING}/server/server.mjs" ]] && pass "MCPB4 staging server.mjs exists" \
  || fail "MCPB4 staging server.mjs missing"
[[ -d "${STAGING}/server/lib" ]] && pass "MCPB4 staging lib/ exists" \
  || fail "MCPB4 staging lib/ missing"
[[ -d "${STAGING}/server/tools" ]] && pass "MCPB4 staging tools/ exists" \
  || fail "MCPB4 staging tools/ missing"
[[ -d "${STAGING}/server/node_modules/@modelcontextprotocol/sdk" ]] \
  && pass "MCPB4 staging bundles @modelcontextprotocol/sdk" \
  || fail "MCPB4 staging missing @modelcontextprotocol/sdk"

# -----------------------------------------------------------------------------
# MCPB4b (v0.3.3 regression test): staging に MCP-invoked shell scripts が含まれる
#
# v0.2.0-v0.3.2 の .mcpb bundle は scripts/ を staging に入れていなかったため、
# Claude Desktop 経由で kioku_ingest_pdf を叩くと `extract-pdf.sh: No such file or
# directory` (rc=127) で失敗していた。v0.3.3 で scripts/ staging コピーを追加。
# 本テストは regression 防止 (手元 build でなく .mcpb 経由で tool が動く前提を固定)。
# -----------------------------------------------------------------------------
[[ -f "${STAGING}/scripts/extract-pdf.sh" ]] \
  && pass "MCPB4b staging includes scripts/extract-pdf.sh (kioku_ingest_pdf 依存)" \
  || fail "MCPB4b staging missing scripts/extract-pdf.sh — kioku_ingest_pdf will fail at runtime"
[[ -x "${STAGING}/scripts/extract-pdf.sh" ]] \
  && pass "MCPB4b extract-pdf.sh is executable (0o755)" \
  || fail "MCPB4b extract-pdf.sh lacks execute permission"
[[ -f "${STAGING}/scripts/mask-text.mjs" ]] \
  && pass "MCPB4b staging includes scripts/mask-text.mjs (extract-pdf.sh 依存)" \
  || fail "MCPB4b staging missing scripts/mask-text.mjs"
[[ -f "${STAGING}/scripts/lib/masking.mjs" ]] \
  && pass "MCPB4b staging includes scripts/lib/masking.mjs (mask-text.mjs 依存)" \
  || fail "MCPB4b staging missing scripts/lib/masking.mjs"
[[ -f "${STAGING}/scripts/extract-url.sh" ]] \
  && pass "MCPB4b staging includes scripts/extract-url.sh (将来の MCP spawn 用)" \
  || fail "MCPB4b staging missing scripts/extract-url.sh"
# auto-ingest.sh / install-*.sh / setup-*.sh は MCP から spawn されないため staging に入らない
[[ ! -f "${STAGING}/scripts/auto-ingest.sh" ]] \
  && pass "MCPB4b staging excludes cron-only scripts/auto-ingest.sh (最小配布)" \
  || fail "MCPB4b staging includes scripts/auto-ingest.sh (不要に同梱されている)"

# ingest/pdf.mjs の path 解決整合確認 (機能 2.4 Phase 2 Task 4 で ingest/pdf.mjs に移設):
# `join(__dirname, '..', '..', '..', 'scripts', 'extract-pdf.sh')` は
# staging では `server/tools/ingest/../../../scripts/extract-pdf.sh` = staging ルート直下 scripts/
# parent repo でも `mcp/tools/ingest/../../../scripts/extract-pdf.sh` = tools/claude-brain/scripts/
# この契約が壊れていないことを確認 (ingest/pdf.mjs にパス文字列が残っている)
grep -q "'..', '..', '..', 'scripts', 'extract-pdf.sh'" "${REPO_ROOT}/tools/claude-brain/mcp/tools/ingest/pdf.mjs" \
  && pass "MCPB4b ingest/pdf.mjs の path resolve が scripts/ staging 配置と整合" \
  || fail "MCPB4b ingest/pdf.mjs の path 文字列が変更された — build-mcpb.sh の staging 位置と再整合すること"

# -----------------------------------------------------------------------------
# MCPB5: --clean removes build/ and dist/
# -----------------------------------------------------------------------------
echo "== MCPB5: --clean =="
set +e
out=$(bash "${BUILD_SCRIPT}" --clean 2>&1)
rc=$?
set -e
assert_eq "0" "${rc}" "MCPB5 exit code is 0"
[[ ! -d "${STAGING}" ]] && pass "MCPB5 staging removed" \
  || fail "MCPB5 staging still present"

# -----------------------------------------------------------------------------
# MCPB6-8: manifest.json sanity (independent of the build script)
# -----------------------------------------------------------------------------
echo "== MCPB6-8: manifest sanity =="
manifest_content="$(cat "${MANIFEST}")"
assert_contains "${manifest_content}" '"name": "kioku-wiki"' "MCPB6 manifest declares name=kioku-wiki"
assert_contains "${manifest_content}" '"vault_path"' "MCPB7 manifest defines vault_path user_config"
assert_contains "${manifest_content}" '"type": "directory"' "MCPB7 vault_path is directory picker"
assert_contains "${manifest_content}" '"OBSIDIAN_VAULT": "${user_config.vault_path}"' \
  "MCPB8 env wiring substitutes vault_path into OBSIDIAN_VAULT"

# -----------------------------------------------------------------------------
# 結果
# -----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "build-mcpb tests:  ok=${PASS}  ng=${FAIL}"
echo "============================================================"
[[ "${FAIL}" -eq 0 ]]
