#!/usr/bin/env bash
#
# discoverqueries-diagnostic.test.sh — Sprint 5.5 PR B55 (BLUE-DOCTOR-DQ-1..3)
#
# Target: scripts/doctor.sh check_discoverqueries_state +
#         tests/fixtures/test-helpers.mjs mockSessionLogScan / readUsageLog
#         (LEARN#8b N=4 reinforcement)
#
# Test prefixes (per-file scope F1..F3、LEARN#8a — NEW file = DQ-1 から):
#   BLUE-DOCTOR-DQ-1   usage log present (entries>=1) → "discoverqueries-usage: ok" + queries count surface
#   BLUE-DOCTOR-DQ-1b  jq-absent + usage log present but entries EMPTY → silent
#                      (regression guard for the pipefail/`grep -c` 取りこぼし:
#                       `grep -c` prints 0 + exits 1 under pipefail → `|| echo "?"`
#                       fired → rough_count="0\n?" → bogus active line. v0.10 hotfix.)
#   BLUE-DOCTOR-DQ-2   opt-out file present → "discoverqueries-optout: warn" + usage/size axis skip (silent)
#   BLUE-DOCTOR-DQ-3   usage log >64KB → "discoverqueries-size: warn" (FIFO rotation 示唆)
#
# 実行: bash tools/claude-brain/tests/discoverqueries-diagnostic.test.sh
#
# 設計方針:
#   - mock 環境は doctor.sh がチェックする他 axis (env / runtime / hook / mcp /
#     metadata / sync / auto-ingest) を最低限 OK 状態にした temp HOME / temp Vault で固める
#   - JSON mode (--json) を主軸にし、discoverqueries-* check id の level を jq で assert
#   - jq 不在環境では grep-fallback path を別途 verify (text mode)
#   - 実 HOME / 実 Vault / 実 ~/.claude / ~/.codex / ~/.gemini に絶対 touch しない

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DOCTOR="${REPO_ROOT}/tools/claude-brain/scripts/doctor.sh"
DQ_LIB="${REPO_ROOT}/tools/claude-brain/mcp/lib/discoverqueries-learning.mjs"
TEST_HELPERS="${REPO_ROOT}/tools/claude-brain/tests/fixtures/test-helpers.mjs"

if [[ ! -f "${DOCTOR}" ]]; then
  echo "FATAL: doctor.sh not found at ${DOCTOR}" >&2
  exit 1
fi
if [[ ! -f "${DQ_LIB}" ]]; then
  echo "FATAL: discoverqueries-learning.mjs not found at ${DQ_LIB}" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "skip: node not installed (discoverqueries-learning helper requires Node 18+)"
  exit 0
fi

HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
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
# axis returns ok (keeps other-axis noise out of the assertions).
seed_summary() {
  local vault="$1"
  local name="${2:-foo}"
  cat > "${vault}/wiki/summaries/${name}.md" <<'EOF'
---
type: summary
---

stub summary
EOF
}

# Run doctor.sh in JSON mode with minimal env. Never reads real
# ~/.claude / ~/.codex / ~/.gemini / real OBSIDIAN_VAULT.
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

# Run doctor.sh in text mode (used for jq-fallback path verification).
run_doctor_text() {
  local vault="$1"
  local fake_home="${TMPROOT}/fake-home-text-$$"
  mkdir -p "${fake_home}"
  env -i \
    HOME="${fake_home}" \
    PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
    OBSIDIAN_VAULT="${vault}" \
    bash "${DOCTOR}" 2>/dev/null || true
}

# Run doctor.sh with jq deterministically ABSENT (forces the grep-based
# fallback branch regardless of whether jq is installed on the test host).
# A stub PATH dir is populated with symlinks to the core binaries doctor.sh
# needs (bash/grep/wc/tr/printf/sed/awk/env/cat/mkdir/...) but *no jq*, so
# `command -v jq` fails inside doctor.sh and HAS_JQ stays 0.
run_doctor_text_nojq() {
  local vault="$1"
  local fake_home="${TMPROOT}/fake-home-nojq-$$"
  local stub_bin="${TMPROOT}/stub-bin-nojq-$$"
  mkdir -p "${fake_home}" "${stub_bin}"
  local tool src
  for tool in bash sh grep wc tr printf sed awk env cat mkdir rm ls dirname \
              basename date node git cut head tail sort uniq find stat \
              command test true false; do
    src="$(PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" command -v "${tool}" 2>/dev/null || true)"
    if [[ -n "${src}" && ! -e "${stub_bin}/${tool}" ]]; then
      ln -s "${src}" "${stub_bin}/${tool}" 2>/dev/null || true
    fi
  done
  env -i \
    HOME="${fake_home}" \
    PATH="${stub_bin}" \
    OBSIDIAN_VAULT="${vault}" \
    bash "${DOCTOR}" 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-DQ-1: usage log present (entries>=1) → discoverqueries-usage ok
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-DQ-1: usage log present → discoverqueries-usage ok"
VAULT_DQ1="$(make_vault vault-dq1)"
seed_summary "${VAULT_DQ1}" "dq1"

# Use mockSessionLogScan + production scanSessionLogs/appendToUsageLog to
# create a real usage log (round-trip verify the privacy-safe pipeline).
node --input-type=module -e "
import { mockSessionLogScan } from '${TEST_HELPERS}';
import { scanSessionLogs, appendToUsageLog } from '${DQ_LIB}';
await mockSessionLogScan('${VAULT_DQ1}', 'doctor-diag-query', 3);
const usage = await scanSessionLogs('${VAULT_DQ1}');
await appendToUsageLog('${VAULT_DQ1}', usage);
" >/dev/null 2>&1

# Precondition: usage log file exists with >=1 entry. (mockSessionLogScan
# writes a `## User (HH:MM:SS)` heading + N `#query` tag refs, so the scan
# yields >=2 distinct query signals — assert ">=1" robustly, not an exact N.)
usage_entries_dq1="$(node --input-type=module -e "
import { readUsageLog } from '${TEST_HELPERS}';
const u = await readUsageLog('${VAULT_DQ1}');
const n = u === null ? 0 : (u.entries || []).length;
console.log(n >= 1 ? 'HAS_ENTRIES' : 'EMPTY');
" 2>&1)"
assert_contains "${usage_entries_dq1}" "HAS_ENTRIES" "DQ-1 precondition: usage log has >=1 entry (helper readUsageLog round-trip)"

if [[ "${HAS_JQ}" -eq 1 ]]; then
  json_dq1="$(run_doctor_json "${VAULT_DQ1}")"
  usage_level_dq1="$(echo "${json_dq1}" | jq -r '.checks[] | select(.id=="discoverqueries-usage") | .level' 2>/dev/null || echo "")"
  usage_msg_dq1="$(echo "${json_dq1}" | jq -r '.checks[] | select(.id=="discoverqueries-usage") | .message' 2>/dev/null || echo "")"
  optout_count_dq1="$(echo "${json_dq1}" | jq '[.checks[] | select(.id=="discoverqueries-optout")] | length' 2>/dev/null || echo "?")"

  assert_eq "ok" "${usage_level_dq1}" "DQ-1 discoverqueries-usage level = ok"
  assert_contains "${usage_msg_dq1}" "queries learned" "DQ-1 usage message surfaces learned query count"
  assert_eq "0" "${optout_count_dq1}" "DQ-1 discoverqueries-optout not surfaced (opt-out absent = silent)"
else
  text_dq1="$(run_doctor_text "${VAULT_DQ1}")"
  assert_contains "${text_dq1}" "DiscoverQueries dynamic learning: active" "DQ-1 (jq-fallback) usage active line in text mode"
fi

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-DQ-1b: jq-absent + usage log present but entries EMPTY → silent
#
# Regression guard for the pipefail / `grep -c` 取りこぼし bug. With an empty
# `entries: []` usage log and jq absent, the old fallback
#   rough_count="$(grep -c '"query"' "$f" | tr -d ' ' || echo "?")"
# would: grep prints "0" but exits 1 → `set -o pipefail` propagates the
# failure → `|| echo "?"` runs → rough_count becomes the 2-line string
# "0\n?", which equals neither "0" nor "?" → falls into the else branch and
# emits a bogus `DiscoverQueries dynamic learning: active (...~0\n? queries
# learned...)` line on what is actually a fresh/empty log. The fix captures
# pipefail-safe (grep `|| true`, strip whitespace+newlines separately,
# empty → "?"). Expected post-fix: discoverqueries-usage stays SILENT (entry
# count 0 = healthy fresh-state default) and the corrupt count never appears.
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-DQ-1b: jq-absent + usage log present but entries empty → silent (pipefail regression guard)"
VAULT_DQ1B="$(make_vault vault-dq1b)"
seed_summary "${VAULT_DQ1B}" "dq1b"

# Usage log present on disk but with zero entries (the production
# canonical-empty shape). No opt-out marker → axis-2 fallback path is reached.
cat > "${VAULT_DQ1B}/.kioku-discoverqueries-usage.json" <<'EOF'
{ "version": 1, "entries": [] }
EOF

text_dq1b="$(run_doctor_text_nojq "${VAULT_DQ1B}")"

# 1. The corrupt 2-line "0\n?" count must NEVER surface.
if printf '%s' "${text_dq1b}" | grep -q -F -- '~0'; then
  fail "DQ-1b corrupt count leaked: '~0' appears in output (pipefail bug regressed)"
else
  pass "DQ-1b no corrupt '~0' count in output"
fi
if printf '%s' "${text_dq1b}" | grep -q -F -- '~?'; then
  fail "DQ-1b corrupt count leaked: '~?' appears in output (pipefail bug regressed)"
else
  pass "DQ-1b no corrupt '~?' count in output"
fi

# 2. Empty log = fresh state → discoverqueries-usage must stay SILENT
#    (no active line at all). Asserting the active phrase is absent covers
#    both "silent" (correct) and rejects the bogus active emission.
if printf '%s' "${text_dq1b}" | grep -q -F -- 'DiscoverQueries dynamic learning: active'; then
  fail "DQ-1b empty usage log wrongly emitted an 'active' line (should be silent on entries:[] )"
else
  pass "DQ-1b empty usage log → discoverqueries-usage silent (no bogus active line)"
fi

# 3. Sanity: this path really exercised the jq-absent fallback (the run must
#    not have crashed — doctor still produced its summary banner).
if printf '%s' "${text_dq1b}" | grep -q -E 'doctor|check|KIOKU|Environment|Runtime'; then
  pass "DQ-1b doctor.sh ran to completion under jq-absent stub PATH"
else
  fail "DQ-1b doctor.sh produced no recognizable output under jq-absent stub PATH"
fi

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-DQ-2: opt-out file present → discoverqueries-optout warn + skip
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-DQ-2: opt-out file present → discoverqueries-optout warn, usage/size skipped"
VAULT_DQ2="$(make_vault vault-dq2)"
seed_summary "${VAULT_DQ2}" "dq2"

# opt-out marker present. A stale usage log is also written to prove that the
# usage / size axis is skipped (silent) when opt-out is active.
: > "${VAULT_DQ2}/.kioku-discoverqueries-opt-out"
cat > "${VAULT_DQ2}/.kioku-discoverqueries-usage.json" <<'EOF'
{ "version": 1, "entries": [ { "query": "stale", "count": 1, "firstSeen": "2026-05-15T00:00:00.000Z", "lastSeen": "2026-05-15T00:00:00.000Z" } ] }
EOF

if [[ "${HAS_JQ}" -eq 1 ]]; then
  json_dq2="$(run_doctor_json "${VAULT_DQ2}")"
  optout_level_dq2="$(echo "${json_dq2}" | jq -r '.checks[] | select(.id=="discoverqueries-optout") | .level' 2>/dev/null || echo "")"
  optout_msg_dq2="$(echo "${json_dq2}" | jq -r '.checks[] | select(.id=="discoverqueries-optout") | .message' 2>/dev/null || echo "")"
  usage_count_dq2="$(echo "${json_dq2}" | jq '[.checks[] | select(.id=="discoverqueries-usage")] | length' 2>/dev/null || echo "?")"
  size_count_dq2="$(echo "${json_dq2}" | jq '[.checks[] | select(.id=="discoverqueries-size")] | length' 2>/dev/null || echo "?")"

  assert_eq "warn" "${optout_level_dq2}" "DQ-2 discoverqueries-optout level = warn"
  assert_contains "${optout_msg_dq2}" "opt-out" "DQ-2 optout message mentions opt-out"
  assert_eq "0" "${usage_count_dq2}" "DQ-2 discoverqueries-usage skipped (opt-out active)"
  assert_eq "0" "${size_count_dq2}" "DQ-2 discoverqueries-size skipped (opt-out active)"
else
  text_dq2="$(run_doctor_text "${VAULT_DQ2}")"
  assert_contains "${text_dq2}" "opt-out enabled" "DQ-2 (jq-fallback) opt-out warn line in text mode"
fi

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-DQ-3: usage log >64KB → discoverqueries-size warn
# -----------------------------------------------------------------------------
echo "BLUE-DOCTOR-DQ-3: usage log >64KB → discoverqueries-size warn (FIFO rotation 示唆)"
VAULT_DQ3="$(make_vault vault-dq3)"
seed_summary "${VAULT_DQ3}" "dq3"

# Hand-craft a usage log JSON whose serialized size exceeds 64KB. doctor.sh
# size axis uses `wc -c` (OS-neutral, no BSD/GNU stat divergence). We DO NOT
# go through appendToUsageLog here (it rotates at 64KB by contract); we want a
# >64KB file on disk so the size axis warn fires deterministically.
node --input-type=module -e "
import { writeFile } from 'node:fs/promises';
const entries = [];
for (let i = 0; i < 1200; i += 1) {
  entries.push({
    query: 'padding-query-' + i + '-' + 'x'.repeat(40),
    count: i + 1,
    firstSeen: '2026-05-15T00:00:00.000Z',
    lastSeen: '2026-05-15T00:00:0' + (i % 10) + '.000Z',
  });
}
const payload = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
await writeFile('${VAULT_DQ3}/.kioku-discoverqueries-usage.json', payload, 'utf8');
" >/dev/null 2>&1

bytes_dq3="$(wc -c < "${VAULT_DQ3}/.kioku-discoverqueries-usage.json" | tr -d ' ')"
if [[ "${bytes_dq3}" -le 65536 ]]; then
  fail "DQ-3 precondition: usage log must exceed 64KB (got ${bytes_dq3} bytes)"
else
  pass "DQ-3 precondition: usage log exceeds 64KB (${bytes_dq3} bytes)"
fi

if [[ "${HAS_JQ}" -eq 1 ]]; then
  json_dq3="$(run_doctor_json "${VAULT_DQ3}")"
  size_level_dq3="$(echo "${json_dq3}" | jq -r '.checks[] | select(.id=="discoverqueries-size") | .level' 2>/dev/null || echo "")"
  size_msg_dq3="$(echo "${json_dq3}" | jq -r '.checks[] | select(.id=="discoverqueries-size") | .message' 2>/dev/null || echo "")"
  usage_level_dq3="$(echo "${json_dq3}" | jq -r '.checks[] | select(.id=="discoverqueries-usage") | .level' 2>/dev/null || echo "")"

  assert_eq "warn" "${size_level_dq3}" "DQ-3 discoverqueries-size level = warn"
  assert_contains "${size_msg_dq3}" "64KB" "DQ-3 size message references the 64KB cap"
  assert_eq "ok" "${usage_level_dq3}" "DQ-3 discoverqueries-usage still ok (entries present, opt-out absent)"
else
  text_dq3="$(run_doctor_text "${VAULT_DQ3}")"
  assert_contains "${text_dq3}" "near capacity" "DQ-3 (jq-fallback) size warn line in text mode"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "summary: ${PASS} pass, ${FAIL} fail"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
