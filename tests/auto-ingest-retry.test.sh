#!/usr/bin/env bash
#
# auto-ingest-retry.test.sh — Sprint 5 PR A5 bash integration smoke test
#
# Verifies that scripts/auto-ingest.sh wires hooks/auto-ingest-retry.mjs at
# the extract / LLM failure paths. Per-file F-number scope (F1..F5):
#
#   F1  PDF extract rc=99 (unknown failure)  → retry queue has 1 entry
#   F2  PDF extract rc=2  (skip = encrypted) → retry queue NOT created
#   F3  claude -p exit 1 (LLM failure)       → retry queue has <llm-batch> entry
#   F4  4 PDF failures for same source       → moved to manual review queue
#   F5  stderr contains ghp_* token literal  → queue file masks as ghp_***
#
# 実行: bash tools/claude-brain/tests/auto-ingest-retry.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
AUTO_INGEST="${REPO_ROOT}/tools/claude-brain/scripts/auto-ingest.sh"
RETRY_HELPER="${REPO_ROOT}/tools/claude-brain/hooks/auto-ingest-retry.mjs"

if [[ ! -x "$(command -v node 2>/dev/null)" ]]; then
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

assert_file_exists() {
  if [[ -f "$1" ]]; then
    pass "$2"
  else
    fail "$2 (file missing: $1)"
  fi
}

assert_file_absent() {
  if [[ ! -f "$1" ]]; then
    pass "$2"
  else
    fail "$2 (file unexpectedly present: $1)"
  fi
}

assert_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then
    pass "$3"
  else
    fail "$3 (substring not found: $2)"
  fi
}

assert_not_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then
    fail "$3 (substring unexpectedly present: $2)"
  else
    pass "$3"
  fi
}

# -----------------------------------------------------------------------------
# Common stubs (claude success, pdfinfo, pdftotext — needed for PDF pre-step gate)
# -----------------------------------------------------------------------------
STUB_DIR="${TMPROOT}/stub-bin"
mkdir -p "${STUB_DIR}"

cat > "${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
echo "stub-claude ok" >&2
exit 0
STUB
chmod +x "${STUB_DIR}/claude"

cat > "${STUB_DIR}/pdfinfo" <<'STUB'
#!/usr/bin/env bash
echo "Pages: 1"
exit 0
STUB
chmod +x "${STUB_DIR}/pdfinfo"

cat > "${STUB_DIR}/pdftotext" <<'STUB'
#!/usr/bin/env bash
echo "stub pdftotext text"
exit 0
STUB
chmod +x "${STUB_DIR}/pdftotext"

# -----------------------------------------------------------------------------
# Vault helper
# -----------------------------------------------------------------------------
make_vault() {
  local name="$1"
  local vault="${TMPROOT}/${name}"
  mkdir -p "${vault}/session-logs" "${vault}/wiki" "${vault}/raw-sources/articles" "${vault}/templates" "${vault}/wiki/summaries"
  : > "${vault}/CLAUDE.md"
  echo "${vault}"
}

# -----------------------------------------------------------------------------
# F1: PDF extract rc=99 (unknown failure) → retry queue has 1 entry
# -----------------------------------------------------------------------------
echo "test F1: PDF extract failure (rc=99) -> retry queue created"
VAULT_F1="$(make_vault vault-f1)"
echo "fake pdf body" > "${VAULT_F1}/raw-sources/articles/foo.pdf"

# Stub extract-pdf.sh that always exits 99 (unknown failure)
EXTRACT_STUB_F1="${TMPROOT}/extract-pdf-fail-f1.sh"
cat > "${EXTRACT_STUB_F1}" <<'STUB'
#!/usr/bin/env bash
echo "stub-extract-pdf: simulated failure" >&2
exit 99
STUB
chmod +x "${EXTRACT_STUB_F1}"

set +e
out_f1="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F1}" \
  KIOKU_EXTRACT_PDF_SCRIPT="${EXTRACT_STUB_F1}" \
  KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc_f1=$?
set -e
assert_eq "0" "${rc_f1}" "F1 auto-ingest exit code 0"
assert_contains "${out_f1}" "extract-pdf.sh failed (rc=99)" "F1 warn message present"
assert_file_exists "${VAULT_F1}/.kioku-auto-ingest-retry.json" "F1 retry queue file created"

# Verify entry shape (use node -e for JSON parsing — avoids jq dependency)
queue_check_f1=$(node -e "
const data = require('${VAULT_F1}/.kioku-auto-ingest-retry.json');
console.log(JSON.stringify({
  count: data.entries.length,
  rawSource: data.entries[0]?.rawSource,
  errorType: data.entries[0]?.errorType,
  retryCount: data.entries[0]?.retryCount,
}));
")
assert_contains "${queue_check_f1}" '"count":1' "F1 entry count = 1"
assert_contains "${queue_check_f1}" '"errorType":"extract_failed"' "F1 errorType = extract_failed"
assert_contains "${queue_check_f1}" '"retryCount":0' "F1 retryCount = 0 (first failure)"
assert_contains "${queue_check_f1}" "foo.pdf" "F1 rawSource includes foo.pdf"

# -----------------------------------------------------------------------------
# F2: PDF extract rc=2 (skip = encrypted) → retry queue NOT created
# -----------------------------------------------------------------------------
echo "test F2: PDF extract rc=2 (info skip) -> retry queue NOT created"
VAULT_F2="$(make_vault vault-f2)"
echo "fake pdf body" > "${VAULT_F2}/raw-sources/articles/encrypted.pdf"

EXTRACT_STUB_F2="${TMPROOT}/extract-pdf-skip-f2.sh"
cat > "${EXTRACT_STUB_F2}" <<'STUB'
#!/usr/bin/env bash
echo "stub-extract-pdf: encrypted (info skip)" >&2
exit 2
STUB
chmod +x "${EXTRACT_STUB_F2}"

set +e
out_f2="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F2}" \
  KIOKU_EXTRACT_PDF_SCRIPT="${EXTRACT_STUB_F2}" \
  KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc_f2=$?
set -e
assert_eq "0" "${rc_f2}" "F2 auto-ingest exit code 0"
assert_contains "${out_f2}" "skipped PDF (encrypted/invalid)" "F2 info skip message present"
assert_file_absent "${VAULT_F2}/.kioku-auto-ingest-retry.json" "F2 retry queue NOT created for info-skip rc=2"

# -----------------------------------------------------------------------------
# F3: claude -p exit 1 (LLM failure) → <llm-batch> entry in retry queue
#
# auto-ingest.sh は実行時に export PATH="${HOME}/.local/share/mise/shims:...:/opt/homebrew/bin:..."
# で多くの dir を prepend するため、単純に STUB_DIR を PATH 先頭に置いても real claude が
# /opt/homebrew/bin 等に存在すると shadow される。fake HOME の mise shims に stub claude を
# 配置することで、auto-ingest.sh 自身の export PATH chain で stub が最優先になる。
# -----------------------------------------------------------------------------
echo "test F3: LLM failure (claude exit 1) -> <llm-batch> entry in retry queue"
VAULT_F3="$(make_vault vault-f3)"
cat > "${VAULT_F3}/session-logs/20260517-100000-test-llm-fail.md" <<'EOF'
---
type: session-log
session_id: test-llm-fail
ingested: false
---

body
EOF

FAKE_HOME_F3="${TMPROOT}/fake-home-f3"
FAKE_MISE_F3="${FAKE_HOME_F3}/.local/share/mise/shims"
mkdir -p "${FAKE_MISE_F3}"
cat > "${FAKE_MISE_F3}/claude" <<'STUB'
#!/usr/bin/env bash
echo "stub-claude: anthropic.error: 529 Overloaded" >&2
exit 1
STUB
chmod +x "${FAKE_MISE_F3}/claude"

# node は real 実装が必要 (helper を spawn する) ため /usr/bin etc. を残す。
set +e
out_f3="$(
  HOME="${FAKE_HOME_F3}" \
  PATH="${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F3}" \
  bash "${AUTO_INGEST}" 2>&1
)"
rc_f3=$?
set -e
assert_eq "0" "${rc_f3}" "F3 auto-ingest exit code 0 (no longer fatal on LLM failure)"
assert_contains "${out_f3}" "claude -p failed (rc=1)" "F3 LLM failure warn present"
assert_file_exists "${VAULT_F3}/.kioku-auto-ingest-retry.json" "F3 retry queue file created"

queue_check_f3=$(node -e "
const data = require('${VAULT_F3}/.kioku-auto-ingest-retry.json');
console.log(JSON.stringify({
  count: data.entries.length,
  rawSource: data.entries[0]?.rawSource,
  errorType: data.entries[0]?.errorType,
}));
")
assert_contains "${queue_check_f3}" '"count":1' "F3 entry count = 1"
assert_contains "${queue_check_f3}" '"errorType":"llm_failed"' "F3 errorType = llm_failed (auto-classified from anthropic.error)"
assert_contains "${queue_check_f3}" "<llm-batch>" "F3 rawSource = <llm-batch> placeholder"

# -----------------------------------------------------------------------------
# F4: 4 PDF failures for same source → moved to manual review queue
# -----------------------------------------------------------------------------
echo "test F4: 4 consecutive PDF failures -> entry moved to manual review queue"
VAULT_F4="$(make_vault vault-f4)"
echo "fake pdf body" > "${VAULT_F4}/raw-sources/articles/persistent-fail.pdf"

EXTRACT_STUB_F4="${TMPROOT}/extract-pdf-fail-f4.sh"
cat > "${EXTRACT_STUB_F4}" <<'STUB'
#!/usr/bin/env bash
echo "stub-extract-pdf: persistent failure" >&2
exit 99
STUB
chmod +x "${EXTRACT_STUB_F4}"

# Run auto-ingest 4 times in a row, simulating 4 cron ticks
for tick in 1 2 3 4; do
  set +e
  PATH="${STUB_DIR}:${PATH}" \
    OBSIDIAN_VAULT="${VAULT_F4}" \
    KIOKU_EXTRACT_PDF_SCRIPT="${EXTRACT_STUB_F4}" \
    KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
    KIOKU_DRY_RUN=1 \
    bash "${AUTO_INGEST}" >/dev/null 2>&1
  set -e
done

assert_file_exists "${VAULT_F4}/.kioku-auto-ingest-manual-review.json" "F4 manual review queue created after 4 ticks"

manual_check_f4=$(node -e "
const data = require('${VAULT_F4}/.kioku-auto-ingest-manual-review.json');
console.log(JSON.stringify({
  count: data.entries.length,
  retryCount: data.entries[0]?.retryCount,
  rawSource: data.entries[0]?.rawSource,
}));
")
assert_contains "${manual_check_f4}" '"count":1' "F4 manual review has 1 entry"
assert_contains "${manual_check_f4}" '"retryCount":3' "F4 retryCount = 3 at promotion"
assert_contains "${manual_check_f4}" "persistent-fail.pdf" "F4 rawSource preserved"

# Retry queue should NOT contain this rawSource any more (could be empty file = removed)
if [[ -f "${VAULT_F4}/.kioku-auto-ingest-retry.json" ]]; then
  retry_check_f4=$(node -e "
const data = require('${VAULT_F4}/.kioku-auto-ingest-retry.json');
const persistent = data.entries.filter(e => e.rawSource && e.rawSource.includes('persistent-fail.pdf'));
console.log(persistent.length);
")
  assert_eq "0" "${retry_check_f4}" "F4 retry queue no longer holds promoted entry"
else
  pass "F4 retry queue no longer holds promoted entry"
fi

# -----------------------------------------------------------------------------
# F5: stderr contains ghp_* token literal → queue file masks as ghp_***
# -----------------------------------------------------------------------------
echo "test F5: credential masking applied to retry queue file"
VAULT_F5="$(make_vault vault-f5)"
echo "fake pdf body" > "${VAULT_F5}/raw-sources/articles/leaky.pdf"

EXTRACT_STUB_F5="${TMPROOT}/extract-pdf-leak-f5.sh"
cat > "${EXTRACT_STUB_F5}" <<'STUB'
#!/usr/bin/env bash
echo "fatal: https://ghp_LeakedSecretToken1234567890abcdefg@github.com/repo failed" >&2
exit 99
STUB
chmod +x "${EXTRACT_STUB_F5}"

set +e
PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F5}" \
  KIOKU_EXTRACT_PDF_SCRIPT="${EXTRACT_STUB_F5}" \
  KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
set -e

assert_file_exists "${VAULT_F5}/.kioku-auto-ingest-retry.json" "F5 retry queue file created"
queue_raw_f5="$(cat "${VAULT_F5}/.kioku-auto-ingest-retry.json")"
assert_not_contains "${queue_raw_f5}" "ghp_LeakedSecretToken1234567890" "F5 token literal NOT in queue file"
assert_contains "${queue_raw_f5}" "ghp_***" "F5 masked replacement present in queue file"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "summary: ${PASS} pass, ${FAIL} fail"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
