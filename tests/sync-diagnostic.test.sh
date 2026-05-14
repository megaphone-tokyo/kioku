#!/usr/bin/env bash
#
# sync-diagnostic.test.sh — Sprint 4 Phase 4 PR B4 (BLUE-DOCTOR-SYNC-1..3)
#
# Target: scripts/doctor.sh の check_sync_state section
#
# Test ID: BLUE-DOCTOR-SYNC-* (LEARN#8a per-file scope、本 file 内 unique)
#
# 方針:
#   - 既存 doctor.test.sh と同 env-isolated pattern: env -i + temp HOME/Vault + PATH stub
#   - 新規 curl stub で network reachability の ok / fail を切り替え
#   - retry queue JSON は production schema (errorType/message/firstAttempt/
#     lastAttempt/retryCount) と pin させて、schema drift で test が落ちるよう
#     forcing function を入れる
#   - 実 HOME / 実 Vault / 実 ~/.claude 等は absolutely touch しない

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DOCTOR="${REPO_ROOT}/tools/claude-brain/scripts/doctor.sh"

if [[ ! -f "${DOCTOR}" ]]; then
  echo "FATAL: doctor.sh not found at ${DOCTOR}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "WARN: jq is not installed; sync-diagnostic tests rely on jq, will be skipped" >&2
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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  if printf '%s' "${haystack}" | grep -q -F -- "${needle}"; then
    pass "${msg}"
  else
    fail "${msg} (substring not found: ${needle})"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  if printf '%s' "${haystack}" | grep -q -F -- "${needle}"; then
    fail "${msg} (unexpected substring found: ${needle})"
  else
    pass "${msg}"
  fi
}

# -----------------------------------------------------------------------------
# Test scaffolding (mirrors doctor.test.sh patterns)
# -----------------------------------------------------------------------------

new_case() {
  local name="$1"
  local case_dir="${TMPROOT}/cases/${name}"
  mkdir -p "${case_dir}/home" "${case_dir}/vault" "${case_dir}/bin"
  echo "${case_dir}"
}

write_stub() {
  local bin_dir="$1"
  local name="$2"
  local output="${3:-}"
  cat >"${bin_dir}/${name}" <<EOF
#!/usr/bin/env bash
$( [[ -n "${output}" ]] && echo "echo '${output}'" )
exit 0
EOF
  chmod +x "${bin_dir}/${name}"
}

# Build a PATH that includes the case-specific bin/ + curated system dirs.
# `git` and `jq` must resolve to real binaries; `curl` is stubbed per-case.
build_path() {
  local case_bin="$1"
  local extras=""
  local p
  for p in /usr/bin /bin /usr/sbin /sbin /opt/homebrew/bin /usr/local/bin; do
    [[ -d "${p}" ]] && extras="${extras}:${p}"
  done
  printf '%s%s' "${case_bin}" "${extras}"
}

stub_full_clis() {
  local bin="$1"
  write_stub "${bin}" "claude"
  write_stub "${bin}" "codex"
  write_stub "${bin}" "gemini"
  write_stub "${bin}" "qmd"
  write_stub "${bin}" "pdfinfo"
  write_stub "${bin}" "pdftotext"
}

stub_node_18() {
  local bin="$1"
  cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version|-v) echo "v18.20.0" ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "${bin}/node"
}

# curl stub that always succeeds (network ok scenario)
stub_curl_ok() {
  local bin="$1"
  cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
# stub curl: success regardless of args
exit 0
EOF
  chmod +x "${bin}/curl"
}

# curl stub that always fails (network unreachable scenario)
stub_curl_fail() {
  local bin="$1"
  cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
# stub curl: failure regardless of args (simulates network down)
exit 6
EOF
  chmod +x "${bin}/curl"
}

# Vault setup: full Vault with one initial commit so `git log -1` works
init_full_vault_with_commit() {
  local vault="$1"
  mkdir -p "${vault}/wiki" "${vault}/session-logs" "${vault}/raw-sources" "${vault}/templates"
  cat >"${vault}/.gitignore" <<'EOF'
session-logs/
.cache/
.obsidian/
EOF
  (
    cd "${vault}"
    git init --quiet 2>/dev/null
    git -c user.email=test@local -c user.name=test \
        commit --allow-empty -m "initial" --quiet 2>/dev/null
  ) || true
}

# Run doctor with overridden env. Mirrors run_doctor() in doctor.test.sh but
# allows the caller to pre-stub curl ok/fail before invocation.
run_doctor_with_env() {
  local case_dir="$1"; shift
  local home="${case_dir}/home"
  local vault="${case_dir}/vault"
  local case_bin="${case_dir}/bin"
  local path
  path="$(build_path "${case_bin}")"

  env -i \
    HOME="${home}" \
    PATH="${path}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    OBSIDIAN_VAULT="${vault}" \
    "$@" \
    bash "${DOCTOR}"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-SYNC-1: healthy state
#   Vault is Git repo, has a commit, no retry queue, network ok
# -----------------------------------------------------------------------------
test_sync_state_healthy() {
  echo "BLUE-DOCTOR-SYNC-1: healthy sync state → ok lines (last commit + no retry + network ok)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "sync-healthy")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  local out
  set +e
  out="$(run_doctor_with_env "${d}" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   Last Vault commit:" \
    "SYNC-1: last commit timestamp printed"
  assert_contains "${out}" "[ok]   No pending sync retry" \
    "SYNC-1: no pending retry → ok line"
  assert_contains "${out}" "[ok]   Network: github.com reachable" \
    "SYNC-1: network reachable → ok line"
  assert_not_contains "${out}" "[warn] Pending sync retry queue" \
    "SYNC-1: no pending retry warn line"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-SYNC-2: pending retry queue
#   .kioku-sync-retry.json exists with retryCount=3 + errorType=network
#   Network is also unreachable (composed scenario) — but the focus is the
#   pending retry warn line with parsed details.
# -----------------------------------------------------------------------------
test_sync_state_pending_retry() {
  echo "BLUE-DOCTOR-SYNC-2: pending retry queue → warn with retryCount + errorType + firstAttempt"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "sync-pending-retry")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  # Write a realistic retry queue file matching sync-vault.mjs schema
  cat >"${d}/vault/.kioku-sync-retry.json" <<'EOF'
{
  "errorType": "network",
  "message": "Could not resolve host: github.com",
  "firstAttempt": "2026-05-14T10:00:00.000Z",
  "lastAttempt": "2026-05-15T03:00:00.000Z",
  "retryCount": 3
}
EOF

  local out
  set +e
  out="$(run_doctor_with_env "${d}" 2>&1)"
  set -e

  assert_contains "${out}" "[warn] Pending sync retry queue" \
    "SYNC-2: pending retry warn line emitted"
  assert_contains "${out}" "3 attempts" \
    "SYNC-2: retryCount=3 surfaced in detail"
  assert_contains "${out}" "last error: network" \
    "SYNC-2: errorType=network surfaced in detail"
  assert_contains "${out}" "since: 2026-05-14T10:00:00.000Z" \
    "SYNC-2: firstAttempt surfaced in detail"
  assert_contains "${out}" "Next Claude session will retry automatically" \
    "SYNC-2: next_action suggested (retry mechanism)"
  # credential-leak negative assertion: schema must not embed ghp_/token/Bearer
  # since masking happens at write-time. We embedded only a clean stderr so the
  # diagnostic output must not contain any token-like literal either.
  assert_not_contains "${out}" "ghp_" \
    "SYNC-2: diagnostic output never contains ghp_ token literal"
  assert_not_contains "${out}" "Bearer " \
    "SYNC-2: diagnostic output never contains Bearer header literal"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-SYNC-3: network unreachable
#   curl stub exits non-zero → diagnostic emits the unreachable warn line.
# -----------------------------------------------------------------------------
test_sync_state_network_unreachable() {
  echo "BLUE-DOCTOR-SYNC-3: github.com unreachable → warn with reconnect hint"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "sync-network-unreachable")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_fail "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  local out
  set +e
  out="$(run_doctor_with_env "${d}" 2>&1)"
  set -e

  assert_contains "${out}" "[warn] Network: github.com unreachable" \
    "SYNC-3: network unreachable warn line emitted"
  assert_contains "${out}" "auto-sync will queue until reconnected" \
    "SYNC-3: user notice mentions auto-queue + reconnect"
  # Even when network is down, the other two sync axes should still report ok
  # for a healthy Vault with no retry queue. This guards against the
  # diagnostic short-circuiting on the first non-ok finding.
  assert_contains "${out}" "[ok]   Last Vault commit:" \
    "SYNC-3: last commit still surfaced when only network fails"
  assert_contains "${out}" "[ok]   No pending sync retry" \
    "SYNC-3: no-pending-retry still surfaced when only network fails"
}

# -----------------------------------------------------------------------------
# Run all
# -----------------------------------------------------------------------------
test_sync_state_healthy
test_sync_state_pending_retry
test_sync_state_network_unreachable

echo ""
echo "sync-diagnostic.test.sh: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
exit 0
