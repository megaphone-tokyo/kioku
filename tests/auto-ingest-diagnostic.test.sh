#!/usr/bin/env bash
#
# auto-ingest-diagnostic.test.sh — Sprint 5 PR B5 (BLUE-DOCTOR-AI-1..5)
#
# Target: scripts/doctor.sh check_auto_ingest_state + tests/fixtures/test-helpers.mjs
#         mockAutoIngestFailure / readAutoIngestRetryQueue (LEARN#8b N=3 mandatory extract)
#
# Test prefixes (per-file scope F1..F5、LEARN#8a):
#   BLUE-DOCTOR-AI-1   healthy state (no retry queue) → "auto-ingest-retry: ok"
#   BLUE-DOCTOR-AI-2   pending retry queue (1 extract_failed entry) → "auto-ingest-retry: warn" with errorType
#   BLUE-DOCTOR-AI-3   manual review queue (3 連敗 promoted entry) → "auto-ingest-manual: fail"
#   BLUE-DOCTOR-AI-4   mockAutoIngestFailure helper produces functional stub script
#   BLUE-DOCTOR-AI-5   readAutoIngestRetryQueue / readAutoIngestManualReviewQueue helper round-trip
#
# 実行: bash tools/claude-brain/tests/auto-ingest-diagnostic.test.sh
#
# 設計方針:
#   - mock 環境は doctor.sh がチェックする他 axis (env / runtime / hook / mcp /
#     metadata / sync) を最低限 OK 状態にした temp HOME / temp Vault で固める
#   - JSON mode (--json) を主軸にし、auto-ingest-* check id の level を jq で assert
#   - LEARN#8b N=3 extract した helper (mockAutoIngestFailure /
#     readAutoIngestRetryQueue) を import & 実 functional verify

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DOCTOR="${REPO_ROOT}/tools/claude-brain/scripts/doctor.sh"
RETRY_HELPER="${REPO_ROOT}/tools/claude-brain/hooks/auto-ingest-retry.mjs"
TEST_HELPERS="${REPO_ROOT}/tools/claude-brain/tests/fixtures/test-helpers.mjs"

if [[ ! -f "${DOCTOR}" ]]; then
  echo "FATAL: doctor.sh not found at ${DOCTOR}" >&2
  exit 1
fi
if [[ ! -f "${RETRY_HELPER}" ]]; then
  echo "FATAL: auto-ingest-retry.mjs not found at ${RETRY_HELPER}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "skip: jq not installed (auto-ingest-diagnostic tests use --json mode)"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip: node not installed (auto-ingest-retry helper requires Node 18+)"
  exit 0
fi

TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

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
# Common: minimum-viable Vault setup
# -----------------------------------------------------------------------------
make_vault() {
  local name="$1"
  local vault="${TMPROOT}/${name}"
  mkdir -p "${vault}/session-logs" "${vault}/wiki/summaries" \
           "${vault}/raw-sources/articles" "${vault}/templates"
  : > "${vault}/CLAUDE.md"
  cat > "${vault}/.gitignore" <<'EOF'
session-logs/
.cache/
.obsidian/
.DS_Store
EOF
  echo "${vault}"
}

# Pre-populate a wiki/summaries entry so check_auto_ingest_state's "last marker"
# axis returns ok (rather than "warn: no activity yet").
seed_summary() {
  local vault="$1"
  local name="${2:-foo}"
  cat > "${vault}/wiki/summaries/${name}.md" <<'EOF'
---
type: summary
source_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
---

stub summary
EOF
}

# Run doctor.sh in JSON mode with minimal env. Returns the JSON to stdout,
# never reads real ~/.claude / ~/.codex / ~/.gemini / real OBSIDIAN_VAULT.
run_doctor_json() {
  local vault="$1"
  local fake_home="${TMPROOT}/fake-home-$$"
  mkdir -p "${fake_home}"
  env -i \
    HOME="${fake_home}" \
    PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
    OBSIDIAN_VAULT="${vault}" \
    bash "${DOCTOR}" --json 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-1: healthy state (no retry queue) → "auto-ingest-retry: ok"
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-AI-1: no retry queue file → auto-ingest-retry ok"
VAULT_AI1="$(make_vault vault-ai1)"
seed_summary "${VAULT_AI1}" "ai1"

json_ai1="$(run_doctor_json "${VAULT_AI1}")"
retry_level_ai1="$(echo "${json_ai1}" | jq -r '.checks[] | select(.id=="auto-ingest-retry") | .level' 2>/dev/null || echo "")"
retry_msg_ai1="$(echo "${json_ai1}" | jq -r '.checks[] | select(.id=="auto-ingest-retry") | .message' 2>/dev/null || echo "")"
last_level_ai1="$(echo "${json_ai1}" | jq -r '.checks[] | select(.id=="auto-ingest-last") | .level' 2>/dev/null || echo "")"

assert_eq "ok" "${retry_level_ai1}" "AI-1 auto-ingest-retry level = ok"
assert_contains "${retry_msg_ai1}" "No pending auto-ingest retry" "AI-1 retry message = healthy"
assert_eq "ok" "${last_level_ai1}" "AI-1 auto-ingest-last level = ok (wiki/summaries seeded)"

# manual review section should NOT appear (silent when absent / empty)
manual_count_ai1="$(echo "${json_ai1}" | jq '[.checks[] | select(.id=="auto-ingest-manual")] | length' 2>/dev/null || echo "?")"
assert_eq "0" "${manual_count_ai1}" "AI-1 auto-ingest-manual not surfaced in healthy state"

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-2: pending retry queue → "auto-ingest-retry: warn" with errorType
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-AI-2: pending retry queue (1 entry) → auto-ingest-retry warn"
VAULT_AI2="$(make_vault vault-ai2)"
seed_summary "${VAULT_AI2}" "ai2"

# Use the production helper to create a retry queue entry (round-trip verify)
echo "extract-pdf.sh: failed (rc=99) — diagnostic test mock" \
  | OBSIDIAN_VAULT="${VAULT_AI2}" \
    node "${RETRY_HELPER}" --enqueue "raw-sources/articles/pending.pdf" "extract_failed" >/dev/null

json_ai2="$(run_doctor_json "${VAULT_AI2}")"
retry_level_ai2="$(echo "${json_ai2}" | jq -r '.checks[] | select(.id=="auto-ingest-retry") | .level')"
retry_msg_ai2="$(echo "${json_ai2}" | jq -r '.checks[] | select(.id=="auto-ingest-retry") | .message')"

assert_eq "warn" "${retry_level_ai2}" "AI-2 auto-ingest-retry level = warn"
assert_contains "${retry_msg_ai2}" "1 entries" "AI-2 message includes entry count"
assert_contains "${retry_msg_ai2}" "extract_failed" "AI-2 message includes errorType"

# manual review still absent
manual_count_ai2="$(echo "${json_ai2}" | jq '[.checks[] | select(.id=="auto-ingest-manual")] | length')"
assert_eq "0" "${manual_count_ai2}" "AI-2 auto-ingest-manual still absent (only retry queue populated)"

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-3: manual review queue (3 連敗 promoted) → "auto-ingest-manual: fail"
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-AI-3: manual review queue populated → auto-ingest-manual fail"
VAULT_AI3="$(make_vault vault-ai3)"
seed_summary "${VAULT_AI3}" "ai3"

# 4 consecutive failures for the same rawSource → promotes on 4th
for tick in 1 2 3 4; do
  echo "extract-pdf.sh: failed (rc=99) — tick ${tick}" \
    | OBSIDIAN_VAULT="${VAULT_AI3}" \
      node "${RETRY_HELPER}" --enqueue "raw-sources/articles/persistent.pdf" "extract_failed" >/dev/null
done

# Verify the promotion happened (precondition for AI-3 assertion)
manual_pre_ai3="$(jq -r '.entries | length' "${VAULT_AI3}/.kioku-auto-ingest-manual-review.json" 2>/dev/null || echo "?")"
assert_eq "1" "${manual_pre_ai3}" "AI-3 precondition: 1 entry in manual review after 4 failures"

json_ai3="$(run_doctor_json "${VAULT_AI3}")"
manual_level_ai3="$(echo "${json_ai3}" | jq -r '.checks[] | select(.id=="auto-ingest-manual") | .level')"
manual_msg_ai3="$(echo "${json_ai3}" | jq -r '.checks[] | select(.id=="auto-ingest-manual") | .message')"

assert_eq "fail" "${manual_level_ai3}" "AI-3 auto-ingest-manual level = fail"
assert_contains "${manual_msg_ai3}" "1 entries" "AI-3 manual message includes entry count"
assert_contains "${manual_msg_ai3}" "human action required" "AI-3 message indicates human review needed"

# Retry queue should be empty (entry was promoted, file removed)
retry_level_ai3="$(echo "${json_ai3}" | jq -r '.checks[] | select(.id=="auto-ingest-retry") | .level')"
assert_eq "ok" "${retry_level_ai3}" "AI-3 auto-ingest-retry level = ok (entry promoted to manual review)"

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-4: mockAutoIngestFailure helper produces functional stub
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-AI-4: mockAutoIngestFailure helper functional verify"
helper_check_ai4="$(node --input-type=module -e "
import { mockAutoIngestFailure } from '${TEST_HELPERS}';
const { path, restore } = await mockAutoIngestFailure('llm_failed');
import('node:child_process').then(({ spawnSync }) => {
  const r = spawnSync('bash', [path]);
  console.log(JSON.stringify({
    rc: r.status,
    stderr_includes_test_mock: (r.stderr.toString() || '').includes('test mock'),
    stderr_includes_classify_keyword: (r.stderr.toString() || '').includes('claude'),
  }));
  return restore();
}).catch(e => { console.error(e); process.exit(1); });
" 2>&1)"

assert_contains "${helper_check_ai4}" '"rc":99' "AI-4 stub exits rc=99 (default unknown failure)"
assert_contains "${helper_check_ai4}" '"stderr_includes_test_mock":true' "AI-4 stub stderr contains 'test mock'"
assert_contains "${helper_check_ai4}" '"stderr_includes_classify_keyword":true' "AI-4 llm_failed stub stderr contains 'claude' (classifyAutoIngestError trigger word)"

# Verify each errorType produces a distinct, classifyAutoIngestError-matching stderr
for et in extract_failed llm_failed fs_error sha256_drift unknown; do
  helper_match="$(node --input-type=module -e "
import { mockAutoIngestFailure } from '${TEST_HELPERS}';
import { classifyAutoIngestError } from '${RETRY_HELPER}';
const { path, restore } = await mockAutoIngestFailure('${et}');
import('node:child_process').then(({ spawnSync }) => {
  const r = spawnSync('bash', [path]);
  console.log(classifyAutoIngestError(r.stderr.toString()));
  return restore();
});
" 2>&1)"
  assert_eq "${et}" "${helper_match}" "AI-4 ${et} stub stderr round-trips through classifyAutoIngestError"
done

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-5: readAutoIngestRetryQueue + readAutoIngestManualReviewQueue helper round-trip
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-AI-5: readAutoIngest{Retry,ManualReview}Queue helper round-trip"
VAULT_AI5="$(make_vault vault-ai5)"

# missing file → null
read_check_ai5_null="$(node --input-type=module -e "
import { readAutoIngestRetryQueue, readAutoIngestManualReviewQueue } from '${TEST_HELPERS}';
const r = await readAutoIngestRetryQueue('${VAULT_AI5}');
const m = await readAutoIngestManualReviewQueue('${VAULT_AI5}');
console.log(JSON.stringify({ retry: r, manual: m }));
" 2>&1)"
assert_contains "${read_check_ai5_null}" '"retry":null' "AI-5 readAutoIngestRetryQueue returns null for missing file"
assert_contains "${read_check_ai5_null}" '"manual":null' "AI-5 readAutoIngestManualReviewQueue returns null for missing file"

# populate retry queue → helper sees 1 entry
echo "extract failed mock" \
  | OBSIDIAN_VAULT="${VAULT_AI5}" \
    node "${RETRY_HELPER}" --enqueue "raw-sources/foo.pdf" "extract_failed" >/dev/null

read_check_ai5_present="$(node --input-type=module -e "
import { readAutoIngestRetryQueue } from '${TEST_HELPERS}';
const r = await readAutoIngestRetryQueue('${VAULT_AI5}');
console.log(JSON.stringify({
  count: r.entries.length,
  rawSource: r.entries[0].rawSource,
  errorType: r.entries[0].errorType,
}));
" 2>&1)"
assert_contains "${read_check_ai5_present}" '"count":1' "AI-5 helper sees 1 entry post-enqueue"
assert_contains "${read_check_ai5_present}" "raw-sources/foo.pdf" "AI-5 helper preserves rawSource"
assert_contains "${read_check_ai5_present}" '"errorType":"extract_failed"' "AI-5 helper preserves errorType"

# malformed JSON tolerated → null
echo "{ broken json" > "${VAULT_AI5}/.kioku-auto-ingest-retry.json"
read_check_ai5_malformed="$(node --input-type=module -e "
import { readAutoIngestRetryQueue } from '${TEST_HELPERS}';
const r = await readAutoIngestRetryQueue('${VAULT_AI5}');
console.log(JSON.stringify({ result: r }));
" 2>&1)"
assert_contains "${read_check_ai5_malformed}" '"result":null' "AI-5 helper returns null for malformed JSON"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "summary: ${PASS} pass, ${FAIL} fail"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
