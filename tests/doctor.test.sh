#!/usr/bin/env bash
#
# doctor.test.sh — scripts/doctor.sh のスモークテスト (BLUE-DOCTOR-*)
#
# 実行: bash tools/claude-brain/tests/doctor.test.sh
#
# 方針:
#   - 実 HOME / 実 Vault / 実 ~/.claude / ~/.codex / ~/.gemini を絶対に touch しない
#   - 全 case を mktemp -d 配下の temp HOME / temp Vault / temp PATH で完結
#   - PATH stub で `claude` `codex` `gemini` `node` `qmd` `pdfinfo` `pdftotext` を
#     擬似的に存在 / 不在 / 古い version に切り替える
#   - 実 jq に依存 (jq が無い環境では一部 case を skip して info 出力)
#
# Test ID: BLUE-DOCTOR-* (LEARN#8a per-file scope、本 file 内 unique)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DOCTOR="${REPO_ROOT}/tools/claude-brain/scripts/doctor.sh"

if [[ ! -f "${DOCTOR}" ]]; then
  echo "FATAL: doctor.sh not found at ${DOCTOR}" >&2
  exit 1
fi

# 実 jq への依存 (本 test 自体が jq を使う)
if ! command -v jq >/dev/null 2>&1; then
  echo "WARN: jq is not installed; doctor JSON-mode tests will be skipped" >&2
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
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (expected=${expected}, actual=${actual})"
  fi
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
# Test scaffolding
#
# new_case <name>:
#   - $TMPROOT/cases/<name>/{home,vault,bin} を作る
#   - bin/ に最低限の stub (claude/codex/gemini/qmd/pdfinfo/pdftotext/node) を配置
#   - run_doctor で env を組んで bash doctor.sh を呼ぶ
#
# stub 戦略:
#   - default (full_stub_path): 全 CLI を stub (= 実 PATH と同じ「全部 install 済」状態)
#   - minimal_stub_path: 必要最小限のみ (jq は実 PATH のものを使う)
# -----------------------------------------------------------------------------

new_case() {
  local name="$1"
  local case_dir="${TMPROOT}/cases/${name}"
  mkdir -p "${case_dir}/home" "${case_dir}/vault" "${case_dir}/bin"
  echo "${case_dir}"
}

# write a small stub command into <bin>/<name> with optional output
write_stub() {
  local bin_dir="$1"
  local name="$2"
  local output="${3:-}"
  cat >"${bin_dir}/${name}" <<EOF
#!/usr/bin/env bash
# stub for ${name}
$( [[ -n "${output}" ]] && echo "echo '${output}'" )
exit 0
EOF
  chmod +x "${bin_dir}/${name}"
}

# Locate real binary path for jq / git / grep / awk so we can preserve them in
# the test PATH while stubbing CLI tools.
real_path_for() {
  local name="$1"
  command -v "${name}" 2>/dev/null || true
}

# Build a minimal PATH that contains:
#   - the case-specific bin/ (CLI stubs)
#   - dirs of jq, git, grep, awk, mktemp, sed, uname, dirname, mkdir, rm, cat,
#     printf, chmod (and other coreutils used by doctor.sh)
# We just include $TMPROOT/bin then fall back to a curated allowlist of dirs
# from the real PATH (avoids leaking $HOME tooling).
build_path() {
  local case_bin="$1"
  local extras=""
  local p
  # Include common system paths so the doctor.sh's internal tooling works.
  for p in /usr/bin /bin /usr/sbin /sbin /opt/homebrew/bin /usr/local/bin; do
    [[ -d "${p}" ]] && extras="${extras}:${p}"
  done
  printf '%s%s' "${case_bin}" "${extras}"
}

# Run doctor with custom env. Returns exit code via $? and stdout via stdout.
# Args: <case_dir> [extra env entries]
run_doctor() {
  local case_dir="$1"; shift
  local home="${case_dir}/home"
  local vault="${case_dir}/vault"
  local case_bin="${case_dir}/bin"
  local path
  path="$(build_path "${case_bin}")"

  # Use env -i to scrub inherited env (avoid host's OBSIDIAN_VAULT etc.)
  env -i \
    HOME="${home}" \
    PATH="${path}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$@" \
    bash "${DOCTOR}"
}

# -----------------------------------------------------------------------------
# Stub builders for common scenarios
#
# stub_full_clis <bin>: stubs claude / codex / gemini / qmd / pdfinfo / pdftotext
# stub_node_18 <bin>: stubs node returning v18.20.0
# stub_node_17 <bin>: stubs node returning v17.99.99
# -----------------------------------------------------------------------------
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

stub_node_17() {
  local bin="$1"
  cat >"${bin}/node" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version|-v) echo "v17.99.99" ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "${bin}/node"
}

# Vault setup helpers
init_full_vault() {
  local vault="$1"
  mkdir -p "${vault}/wiki" "${vault}/session-logs" "${vault}/raw-sources" "${vault}/templates"
  cat >"${vault}/.gitignore" <<'EOF'
session-logs/
.cache/
.obsidian/
EOF
  # Make it look like a git repo via `git init`
  (cd "${vault}" && git init --quiet 2>/dev/null) || true
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-ENV-1: OBSIDIAN_VAULT unset → fail
# -----------------------------------------------------------------------------
test_env_unset() {
  echo "BLUE-DOCTOR-ENV-1: OBSIDIAN_VAULT unset → fail"
  local d
  d="$(new_case "env-unset")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"

  local out
  set +e
  out="$(run_doctor "${d}" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] OBSIDIAN_VAULT is not set" "ENV-1: fail line for unset OBSIDIAN_VAULT"
  assert_eq "1" "${rc}" "ENV-1: exit code 1 (any fail)"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-ENV-2: OBSIDIAN_VAULT set but Vault dir missing → fail
# -----------------------------------------------------------------------------
test_env_vault_dir_missing() {
  echo "BLUE-DOCTOR-ENV-2: OBSIDIAN_VAULT set + Vault dir missing → fail"
  local d
  d="$(new_case "env-vault-missing")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"

  local missing="${d}/does-not-exist"
  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${missing}" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] Vault directory does not exist" "ENV-2: fail line for missing Vault dir"
  assert_contains "${out}" "setup-vault.sh" "ENV-2: suggests setup-vault.sh"
  assert_eq "1" "${rc}" "ENV-2: exit code 1"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-VAULT-1: full Vault → ok subdirs
# -----------------------------------------------------------------------------
test_vault_full_ok() {
  echo "BLUE-DOCTOR-VAULT-1: full Vault subdirs → ok"
  local d
  d="$(new_case "vault-full")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   Vault has wiki/ session-logs/ raw-sources/ templates/" \
    "VAULT-1: all 4 subdirs detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-VAULT-2: only wiki/ → fail with missing list
# -----------------------------------------------------------------------------
test_vault_partial_fail() {
  echo "BLUE-DOCTOR-VAULT-2: only wiki/ → fail listing missing dirs"
  local d
  d="$(new_case "vault-partial")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  mkdir -p "${d}/vault/wiki"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] Vault missing required subdirs:" "VAULT-2: fail line"
  assert_contains "${out}" "session-logs" "VAULT-2: lists session-logs"
  assert_contains "${out}" "raw-sources" "VAULT-2: lists raw-sources"
  assert_contains "${out}" "templates" "VAULT-2: lists templates"
  assert_eq "1" "${rc}" "VAULT-2: exit code 1"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-GITIGNORE-1: .gitignore has session-logs/ + .cache/ → ok
# -----------------------------------------------------------------------------
test_gitignore_complete() {
  echo "BLUE-DOCTOR-GITIGNORE-1: .gitignore complete → ok"
  local d
  d="$(new_case "gitignore-complete")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   .gitignore excludes session-logs/" "GITIGNORE-1: session-logs entry detected"
  assert_contains "${out}" "[ok]   .gitignore excludes .cache/" "GITIGNORE-1: .cache entry detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-GITIGNORE-2: missing session-logs/ → fail (security)
# -----------------------------------------------------------------------------
test_gitignore_missing_session_logs() {
  echo "BLUE-DOCTOR-GITIGNORE-2: missing session-logs/ → fail"
  local d
  d="$(new_case "gitignore-missing-sl")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  # Replace gitignore with one that has only .cache/
  cat >"${d}/vault/.gitignore" <<'EOF'
.cache/
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] .gitignore is missing 'session-logs/'" "GITIGNORE-2: fail line"
  assert_eq "1" "${rc}" "GITIGNORE-2: exit code 1 (security)"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-NODE-1: Node 18+ stub → ok
# -----------------------------------------------------------------------------
test_node_18_ok() {
  echo "BLUE-DOCTOR-NODE-1: Node 18 → ok"
  local d
  d="$(new_case "node-18")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   Node v18.20.0 (>= 18 required)" "NODE-1: Node 18 ok"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-NODE-2: Node 17 stub → fail
# -----------------------------------------------------------------------------
test_node_17_fail() {
  echo "BLUE-DOCTOR-NODE-2: Node 17 → fail"
  local d
  d="$(new_case "node-17")"
  stub_full_clis "${d}/bin"
  stub_node_17 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] Node v17.99.99 is too old" "NODE-2: fail for Node 17"
  assert_eq "1" "${rc}" "NODE-2: exit code 1"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-CLI-CLAUDE-1: claude in PATH → ok
# -----------------------------------------------------------------------------
test_cli_claude_present() {
  echo "BLUE-DOCTOR-CLI-CLAUDE-1: claude in PATH → ok"
  local d
  d="$(new_case "cli-claude-present")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   claude CLI is installed" "CLI-CLAUDE-1: claude detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-CLI-CLAUDE-2: claude not in PATH → fail
# -----------------------------------------------------------------------------
test_cli_claude_missing() {
  echo "BLUE-DOCTOR-CLI-CLAUDE-2: claude not in PATH → fail"
  local d
  d="$(new_case "cli-claude-missing")"
  # Stub everything except claude
  write_stub "${d}/bin" "codex"
  write_stub "${d}/bin" "gemini"
  write_stub "${d}/bin" "qmd"
  write_stub "${d}/bin" "pdfinfo"
  write_stub "${d}/bin" "pdftotext"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] claude CLI is not installed" "CLI-CLAUDE-2: fail line"
  assert_eq "1" "${rc}" "CLI-CLAUDE-2: exit code 1"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-HOOK-CLAUDE-1: settings.json with KIOKU hook → ok
# -----------------------------------------------------------------------------
test_hook_claude_present() {
  echo "BLUE-DOCTOR-HOOK-CLAUDE-1: ~/.claude/settings.json with session-logger.mjs → ok"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "hook-claude-present")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  mkdir -p "${d}/home/.claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node /tmp/session-logger.mjs" } ] }
    ]
  }
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   ~/.claude/settings.json registers KIOKU session-logger hook" \
    "HOOK-CLAUDE-1: KIOKU hook detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-HOOK-CLAUDE-2: settings.json without KIOKU hook → fail
# -----------------------------------------------------------------------------
test_hook_claude_missing_kioku() {
  echo "BLUE-DOCTOR-HOOK-CLAUDE-2: ~/.claude/settings.json missing KIOKU hook → fail"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "hook-claude-missing")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  mkdir -p "${d}/home/.claude"
  # settings.json exists but only has unrelated hook
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "echo unrelated" } ] }
    ]
  }
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] ~/.claude/settings.json does not register KIOKU session-logger hook" \
    "HOOK-CLAUDE-2: fail line"
  assert_contains "${out}" "install-hooks.sh --apply" "HOOK-CLAUDE-2: suggests install-hooks.sh"
  assert_eq "1" "${rc}" "HOOK-CLAUDE-2: exit code 1"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-HOOK-CODEX-1: ~/.codex/hooks.json with adapters/codex.mjs → ok
# -----------------------------------------------------------------------------
test_hook_codex_present() {
  echo "BLUE-DOCTOR-HOOK-CODEX-1: ~/.codex/hooks.json with adapters/codex.mjs → ok"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "hook-codex-present")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  mkdir -p "${d}/home/.codex"
  cat >"${d}/home/.codex/hooks.json" <<'EOF'
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node /tmp/hooks/adapters/codex.mjs" } ] }
    ]
  }
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   ~/.codex/hooks.json registers KIOKU codex adapter hook" \
    "HOOK-CODEX-1: KIOKU codex adapter detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-HOOK-GEMINI-1: ~/.gemini/settings.json with claude-brain-* names → ok
# -----------------------------------------------------------------------------
test_hook_gemini_present() {
  echo "BLUE-DOCTOR-HOOK-GEMINI-1: ~/.gemini/settings.json with claude-brain-* → ok"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "hook-gemini-present")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  mkdir -p "${d}/home/.gemini"
  cat >"${d}/home/.gemini/settings.json" <<'EOF'
{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          { "name": "claude-brain-assistant-stop", "type": "command", "command": "node /tmp/x.mjs" }
        ]
      }
    ]
  }
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   ~/.gemini/settings.json registers KIOKU gemini hooks" \
    "HOOK-GEMINI-1: KIOKU gemini hooks detected"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-VERSION-1: All 4 metadata files share same version → ok
#
# 本 test は実 repo の metadata を読むため、parity が崩れていれば fail と出る
# (これは実は望ましい — repo 側の release prep を doctor が pin する)
# -----------------------------------------------------------------------------
test_version_parity_real_repo() {
  echo "BLUE-DOCTOR-VERSION-1: real repo metadata version parity → ok (or fail if drift)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "version-real")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  # In the current repo all 4 files share the same version. If a future PR
  # introduces drift, this assertion will fail (which is the intent).
  assert_contains "${out}" "[ok]   All 4 metadata files report version" \
    "VERSION-1: real repo metadata parity ok"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-EXIT-CODE-1: All-ok scenario → exit 0
# -----------------------------------------------------------------------------
test_exit_code_all_ok() {
  echo "BLUE-DOCTOR-EXIT-CODE-1: full healthy state → exit 0"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "exit-all-ok")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # Configure all hook configs and MCP configs so no fail/warn arises (other
  # than info-level checks that always pass).
  mkdir -p "${d}/home/.claude" "${d}/home/.codex" "${d}/home/.gemini" \
           "${d}/home/Library/Application Support/Claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/session-logger.mjs" } ] } ] } }
EOF
  cat >"${d}/home/.codex/hooks.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/hooks/adapters/codex.mjs" } ] } ] } }
EOF
  cat >"${d}/home/.codex/config.toml" <<'EOF'
[mcp_servers.kioku]
command = "node"
args = ["/x/server.mjs"]
EOF
  cat >"${d}/home/.gemini/settings.json" <<'EOF'
{
  "hooks": { "AfterAgent": [ { "hooks": [ { "name": "claude-brain-assistant-stop", "type": "command", "command": "node /x.mjs" } ] } ] },
  "mcpServers": { "kioku": { "command": "node", "args": ["/x/server.mjs"] } }
}
EOF
  cat >"${d}/home/Library/Application Support/Claude/claude_desktop_config.json" <<'EOF'
{ "mcpServers": { "kioku-wiki": { "command": "node", "args": ["/x/server.mjs"] } } }
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" \
    CLAUDE_DESKTOP_CONFIG="${d}/home/Library/Application Support/Claude/claude_desktop_config.json" \
    2>&1)"
  local rc=$?
  set -e

  assert_eq "0" "${rc}" "EXIT-CODE-1: rc=0 in fully healthy state"
  assert_not_contains "${out}" "[fail]" "EXIT-CODE-1: no [fail] lines"
  assert_not_contains "${out}" "[warn]" "EXIT-CODE-1: no [warn] lines"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-EXIT-CODE-2: 1 fail → exit 1
# -----------------------------------------------------------------------------
test_exit_code_fail() {
  echo "BLUE-DOCTOR-EXIT-CODE-2: 1 fail → exit 1"
  local d
  d="$(new_case "exit-fail")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  # No Vault setup → forces fail on env-vault-dir
  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/no-such-vault" 2>&1)"
  local rc=$?
  set -e
  assert_eq "1" "${rc}" "EXIT-CODE-2: rc=1 when fail present"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-EXIT-CODE-3: warn only (no fail) → exit 2
#
# To produce only warns: full healthy Vault but no qmd / Claude Desktop config
# → at least one warn (warn = qmd missing or Claude Desktop config missing) +
# CLI agent warns (codex/gemini absent if only claude is stubbed).
# -----------------------------------------------------------------------------
test_exit_code_warn_only() {
  echo "BLUE-DOCTOR-EXIT-CODE-3: warn only (no fail) → exit 2"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "exit-warn-only")"
  # Stub claude only (codex / gemini absent → warn)
  # Stub poppler so no warn from there.
  write_stub "${d}/bin" "claude"
  write_stub "${d}/bin" "pdfinfo"
  write_stub "${d}/bin" "pdftotext"
  # qmd intentionally missing → warn
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # Claude hook ok, but Claude Desktop config absent → warn (not fail)
  mkdir -p "${d}/home/.claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/session-logger.mjs" } ] } ] } }
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_not_contains "${out}" "[fail]" "EXIT-CODE-3: no fail lines"
  assert_contains "${out}" "[warn]" "EXIT-CODE-3: at least one warn line"
  assert_eq "2" "${rc}" "EXIT-CODE-3: rc=2 (warn only)"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-JSON-1: --json output is parseable + has summary + checks
# -----------------------------------------------------------------------------
test_json_output() {
  echo "BLUE-DOCTOR-JSON-1: --json mode emits valid JSON"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "json-mode")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # run_doctor does not pass extra CLI args to doctor.sh (its trailing $@ is
  # treated as additional env assignments by env -i). For --json we invoke
  # bash directly with the same scrubbed-env pattern.
  local out
  set +e
  out="$(env -i \
        HOME="${d}/home" \
        PATH="$(build_path "${d}/bin")" \
        TMPDIR="${TMPDIR:-/tmp}" \
        OBSIDIAN_VAULT="${d}/vault" \
        bash "${DOCTOR}" --json 2>&1)"
  set -e

  # Validate JSON parse + structure
  if printf '%s' "${out}" | jq -e '.summary.ok and .summary.warn and .summary.fail and (.checks|length > 0)' >/dev/null 2>&1; then
    pass "JSON-1: --json emits {summary, checks[]}"
  else
    # ok==0 が falsy になり得るので別判定 (any field exists) — ok=0 case 用
    if printf '%s' "${out}" | jq -e '(.summary | has("ok") and has("warn") and has("fail")) and (.checks|length > 0)' >/dev/null 2>&1; then
      pass "JSON-1: --json emits {summary, checks[]}"
    else
      fail "JSON-1: --json output is not valid (got: $(printf '%s' "${out}" | head -c 200))"
    fi
  fi
}

# -----------------------------------------------------------------------------
# Run all
# -----------------------------------------------------------------------------
test_env_unset
test_env_vault_dir_missing
test_vault_full_ok
test_vault_partial_fail
test_gitignore_complete
test_gitignore_missing_session_logs
test_node_18_ok
test_node_17_fail
test_cli_claude_present
test_cli_claude_missing
test_hook_claude_present
test_hook_claude_missing_kioku
test_hook_codex_present
test_hook_gemini_present
test_version_parity_real_repo
test_exit_code_all_ok
test_exit_code_fail
test_exit_code_warn_only
test_json_output

echo ""
echo "doctor.test.sh: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
exit 0
