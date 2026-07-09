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

# run_doctor と同じ env 組み立てで `--quick` を渡す (v0.11 S6-6)。
# run_doctor は末尾可変長引数を env entries として受けるため script 引数を
# 渡せない — quick 用に helper を分ける (env 組み立ての duplication は許容)。
run_doctor_quick() {
  local case_dir="$1"; shift
  local home="${case_dir}/home"
  local case_bin="${case_dir}/bin"
  local path
  path="$(build_path "${case_bin}")"

  env -i \
    HOME="${home}" \
    PATH="${path}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$@" \
    bash "${DOCTOR}" --quick
}

# `--quick --json` 組合せ (v0.11 S6-6 受け入れ基準)
run_doctor_quick_json() {
  local case_dir="$1"; shift
  local home="${case_dir}/home"
  local case_bin="${case_dir}/bin"
  local path
  path="$(build_path "${case_bin}")"

  env -i \
    HOME="${home}" \
    PATH="${path}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    "$@" \
    bash "${DOCTOR}" --quick --json
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

# Same as init_full_vault, but adds an empty initial commit so
# `check_sync_state` finds a `git log -1` timestamp. Sprint 4 Phase 4 PR B4.
init_full_vault_with_commit() {
  local vault="$1"
  init_full_vault "${vault}"
  (
    cd "${vault}"
    git -c user.email=test@local -c user.name=test \
        commit --allow-empty -m "initial" --quiet 2>/dev/null
  ) || true
}

# curl stub that always succeeds — used by EXIT-CODE-1/MODE-1 healthy-state
# tests so the new check_sync_state network probe doesn't accidentally emit a
# warn when the host happens to be offline. Sprint 4 Phase 4 PR B4.
stub_curl_ok() {
  local bin="$1"
  cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${bin}/curl"
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
  # v0.11 S6-6: hint は S6-5 の新階層 path を指す (旧 flat path は shim 経由で
  # 動くが、hint は新 path に統一。negative assertion で旧 path 回帰を pinning)
  assert_contains "${out}" "bash scripts/install/user/install-hooks.sh --apply" \
    "HOOK-CLAUDE-2: suggests install-hooks.sh at new hierarchy path"
  assert_not_contains "${out}" "bash scripts/install-hooks.sh" \
    "HOOK-CLAUDE-2: old flat path no longer suggested"
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
  stub_curl_ok "${d}/bin"
  # Sprint 4 Phase 4 PR B4: check_sync_state now part of doctor flow — needs a
  # real commit (for `git log -1`) and a curl stub (network probe).
  init_full_vault_with_commit "${d}/vault"

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
# BLUE-DOCTOR-MODE-1: Hooks ok + MCP ok → Mode C (Full memory)
# -----------------------------------------------------------------------------
test_install_mode_full() {
  echo "BLUE-DOCTOR-MODE-1: hooks + MCP both ok → Mode C (Full memory)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "mode-full")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault "${d}/vault"

  # Claude hook ok
  mkdir -p "${d}/home/.claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/session-logger.mjs" } ] } ] } }
EOF
  # Claude Desktop MCP ok (macOS path under temp HOME)
  local desktop_dir="${d}/home/Library/Application Support/Claude"
  mkdir -p "${desktop_dir}"
  cat >"${desktop_dir}/claude_desktop_config.json" <<'EOF'
{ "mcpServers": { "kioku": { "command": "node", "args": ["/x/mcp/server.mjs"] } } }
EOF

  local out
  set +e
  out="$(env -i \
        HOME="${d}/home" \
        PATH="$(build_path "${d}/bin")" \
        TMPDIR="${TMPDIR:-/tmp}" \
        OBSIDIAN_VAULT="${d}/vault" \
        CLAUDE_DESKTOP_CONFIG="${desktop_dir}/claude_desktop_config.json" \
        bash "${DOCTOR}" 2>&1)"
  set -e

  assert_contains "${out}" "[mode] Current install mode: Mode C (Full memory)" \
    "MODE-1: Mode C label appears"
  assert_contains "${out}" "MCP: ok / Hooks: ok" \
    "MODE-1: detail shows MCP ok and Hooks ok"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-MODE-2: MCP ok, Hooks not registered → Mode A (MCP-only)
# -----------------------------------------------------------------------------
test_install_mode_mcp_only() {
  echo "BLUE-DOCTOR-MODE-2: MCP ok + hooks absent → Mode A (MCP-only)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "mode-mcp-only")"
  # Stub everything except hook CLIs (claude/codex/gemini absent → hook check skipped as warn)
  write_stub "${d}/bin" "qmd"
  write_stub "${d}/bin" "pdfinfo"
  write_stub "${d}/bin" "pdftotext"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # No Claude/Codex/Gemini hooks registered (CLIs absent → all hook checks "warn")
  # But Claude Desktop MCP registered (Claude Desktop config does not need claude CLI)
  local desktop_dir="${d}/home/Library/Application Support/Claude"
  mkdir -p "${desktop_dir}"
  cat >"${desktop_dir}/claude_desktop_config.json" <<'EOF'
{ "mcpServers": { "kioku": { "command": "node", "args": ["/x/mcp/server.mjs"] } } }
EOF

  local out
  set +e
  out="$(env -i \
        HOME="${d}/home" \
        PATH="$(build_path "${d}/bin")" \
        TMPDIR="${TMPDIR:-/tmp}" \
        OBSIDIAN_VAULT="${d}/vault" \
        CLAUDE_DESKTOP_CONFIG="${desktop_dir}/claude_desktop_config.json" \
        bash "${DOCTOR}" 2>&1)"
  set -e

  assert_contains "${out}" "[mode] Current install mode: Mode A (MCP-only)" \
    "MODE-2: Mode A label appears"
  assert_contains "${out}" "MCP: ok / Hooks: not registered" \
    "MODE-2: detail shows MCP ok and Hooks not registered"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-MODE-3: Hooks ok, MCP missing → Unknown / Partial install
#
# Mode B (Read-only) は --read-only flag が install-mcp-client.sh に未実装な
# ため MVP では判定しない。MCP 抜け / Hooks ok の組み合わせも "Unknown /
# Partial install" として扱う (judge は v0.7.x で iterative refine 予定)。
# -----------------------------------------------------------------------------
test_install_mode_unknown() {
  echo "BLUE-DOCTOR-MODE-3: hooks ok + MCP missing → Unknown / Partial install"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "mode-unknown")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # Claude hook ok
  mkdir -p "${d}/home/.claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/session-logger.mjs" } ] } ] } }
EOF
  # No MCP config files at all (Claude Desktop / Codex / Gemini MCP all missing)
  # CLAUDE_DESKTOP_CONFIG points to a non-existent path under temp HOME
  local out
  set +e
  out="$(env -i \
        HOME="${d}/home" \
        PATH="$(build_path "${d}/bin")" \
        TMPDIR="${TMPDIR:-/tmp}" \
        OBSIDIAN_VAULT="${d}/vault" \
        CLAUDE_DESKTOP_CONFIG="${d}/home/no-such-claude-desktop-config.json" \
        bash "${DOCTOR}" 2>&1)"
  set -e

  assert_contains "${out}" "[mode] Current install mode: Unknown / Partial install" \
    "MODE-3: Unknown label appears"
  assert_contains "${out}" "MCP: not registered / Hooks: ok" \
    "MODE-3: detail shows MCP missing and Hooks ok"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-MODE-4: --json mode includes install_mode in summary
# -----------------------------------------------------------------------------
test_install_mode_json() {
  echo "BLUE-DOCTOR-MODE-4: --json summary includes install_mode field"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "mode-json")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  mkdir -p "${d}/home/.claude"
  cat >"${d}/home/.claude/settings.json" <<'EOF'
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /x/session-logger.mjs" } ] } ] } }
EOF
  local desktop_dir="${d}/home/Library/Application Support/Claude"
  mkdir -p "${desktop_dir}"
  cat >"${desktop_dir}/claude_desktop_config.json" <<'EOF'
{ "mcpServers": { "kioku": { "command": "node", "args": ["/x/mcp/server.mjs"] } } }
EOF

  local out
  set +e
  out="$(env -i \
        HOME="${d}/home" \
        PATH="$(build_path "${d}/bin")" \
        TMPDIR="${TMPDIR:-/tmp}" \
        OBSIDIAN_VAULT="${d}/vault" \
        CLAUDE_DESKTOP_CONFIG="${desktop_dir}/claude_desktop_config.json" \
        bash "${DOCTOR}" --json 2>&1)"
  set -e

  if printf '%s' "${out}" | jq -e '.summary.install_mode == "Mode C (Full memory)"' >/dev/null 2>&1; then
    pass "MODE-4: --json summary.install_mode == \"Mode C (Full memory)\""
  else
    fail "MODE-4: --json summary.install_mode missing or wrong (got: $(printf '%s' "${out}" | jq -r '.summary.install_mode // "<absent>"' 2>/dev/null || echo '<unparseable>'))"
  fi
  if printf '%s' "${out}" | jq -e '.summary.install_mode_detail | contains("MCP: ok") and contains("Hooks: ok")' >/dev/null 2>&1; then
    pass "MODE-4: --json summary.install_mode_detail contains MCP ok / Hooks ok"
  else
    fail "MODE-4: --json summary.install_mode_detail missing or wrong"
  fi
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-SYNC-INT-1: check_sync_state is wired into the main flow
#
# Sprint 4 Phase 4 PR B4 integration assertion. Detailed scenario coverage
# (healthy / pending-retry / network-unreachable) lives in
# tests/sync-diagnostic.test.sh — this assertion exists solely to guard
# against the `check_sync_state` call being dropped from doctor.sh's main()
# in a future refactor (LEARN#5 cross-suite reference pinning).
# -----------------------------------------------------------------------------
test_sync_state_integrated() {
  echo "BLUE-DOCTOR-SYNC-INT-1: check_sync_state lines appear in default doctor output"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "sync-integrated")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  # Pre-populate a retry queue with the production schema so the integration
  # assertion also pins schema parity with hooks/sync-vault.mjs.
  cat >"${d}/vault/.kioku-sync-retry.json" <<'EOF'
{
  "errorType": "auth",
  "message": "permission denied (publickey)",
  "firstAttempt": "2026-05-15T01:00:00.000Z",
  "lastAttempt": "2026-05-15T02:00:00.000Z",
  "retryCount": 1
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "Last Vault commit:" \
    "SYNC-INT-1: last commit line surfaces in integrated output"
  assert_contains "${out}" "Pending sync retry queue" \
    "SYNC-INT-1: pending retry line surfaces in integrated output"
  assert_contains "${out}" "last error: auth" \
    "SYNC-INT-1: errorType parsed from production-schema queue file"
  assert_contains "${out}" "Network: github.com reachable" \
    "SYNC-INT-1: network probe surfaces in integrated output"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-AI-INT-1: check_auto_ingest_state surfaces in default doctor output
#
# Sprint 5 PR B5 で追加した check_auto_ingest_state が main() に正しく登録されていて、
# retry queue + manual review queue が text mode 出力にも JSON mode にも現れることを
# pin する。auto-ingest-* の詳細 unit test は tests/auto-ingest-diagnostic.test.sh で
# 持つが、本 assertion は「main() から関数 call が脱落しないこと」を保証する
# regression guard (LEARN#5 cross-suite reference pinning、check_sync_state の AI-INT
# 版)。
# -----------------------------------------------------------------------------
test_auto_ingest_state_integrated() {
  echo "BLUE-DOCTOR-AI-INT-1: check_auto_ingest_state lines appear in default doctor output"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "auto-ingest-integrated")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  # Seed a summary so check_auto_ingest_state's "last marker" axis returns ok
  # (rather than the "no activity yet" warn). init_full_vault_with_commit only
  # creates empty wiki/ — we add wiki/summaries/seed.md to exercise the mtime
  # fallback path of check_auto_ingest_state.
  mkdir -p "${d}/vault/wiki/summaries"
  cat >"${d}/vault/wiki/summaries/seed.md" <<'EOF'
---
type: summary
---
seed
EOF

  # Pre-populate a retry queue with the production schema (Sprint 5 PR A5
  # writeAutoIngestRetryQueue output shape) so the integration assertion also
  # pins schema parity with hooks/auto-ingest-retry.mjs.
  cat >"${d}/vault/.kioku-auto-ingest-retry.json" <<'EOF'
{
  "version": 1,
  "entries": [
    {
      "rawSource": "raw-sources/articles/integration-test.pdf",
      "errorType": "extract_failed",
      "message": "extract-pdf.sh: failed (rc=99) — integration test seed",
      "firstAttempt": "2026-05-17T01:00:00.000Z",
      "lastAttempt": "2026-05-17T02:00:00.000Z",
      "retryCount": 0
    }
  ]
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "Last auto-ingest activity:" \
    "AI-INT-1: last auto-ingest line surfaces in integrated output"
  assert_contains "${out}" "Pending auto-ingest retry queue" \
    "AI-INT-1: pending retry line surfaces in integrated output"
  assert_contains "${out}" "extract_failed" \
    "AI-INT-1: errorType parsed from production-schema queue file"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-DQ-INT-1: check_discoverqueries_state surfaces in default doctor output
#
# Sprint 5.5 PR B55 で追加した check_discoverqueries_state が main() に正しく
# 登録されていて、usage log present 時に discoverqueries-usage ok line が
# text mode 出力に現れることを pin する。discoverqueries-* の詳細 unit test は
# tests/discoverqueries-diagnostic.test.sh で持つが、本 assertion は
# 「main() から関数 call が脱落しないこと」を保証する regression guard
# (LEARN#5 cross-suite reference pinning、check_auto_ingest_state の AI-INT 版)。
# -----------------------------------------------------------------------------
test_discoverqueries_state_integrated() {
  echo "BLUE-DOCTOR-DQ-INT-1: check_discoverqueries_state lines appear in default doctor output"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "discoverqueries-integrated")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  stub_curl_ok "${d}/bin"
  init_full_vault_with_commit "${d}/vault"

  # Pre-populate a usage log with the production schema (Sprint 5.5 PR A55
  # appendToUsageLog output shape) so the integration assertion also pins
  # schema parity with mcp/lib/discoverqueries-learning.mjs.
  cat >"${d}/vault/.kioku-discoverqueries-usage.json" <<'EOF'
{
  "version": 1,
  "entries": [
    {
      "query": "integration-test-query",
      "count": 5,
      "firstSeen": "2026-05-15T01:00:00.000Z",
      "lastSeen": "2026-05-15T02:00:00.000Z"
    }
  ]
}
EOF

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "DiscoverQueries dynamic learning: active" \
    "DQ-INT-1: discoverqueries-usage active line surfaces in integrated output"
  assert_contains "${out}" "queries learned" \
    "DQ-INT-1: entries count parsed from production-schema usage log"

  # v0.11 S6-7 (axis F): recency decay half-life surfaces (run_doctor is
  # env -i clean, so KIOKU_DQ_HALFLIFE_DAYS is unset → default 14).
  assert_contains "${out}" "halfLife=14 days (decay active)" \
    "DQ-INT-2: recency decay half-life line surfaces with default 14"

  # env override: KIOKU_DQ_HALFLIFE_DAYS=7 → halfLife=7 days
  local out_hl7
  set +e
  out_hl7="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" KIOKU_DQ_HALFLIFE_DAYS=7 2>&1)"
  set -e
  assert_contains "${out_hl7}" "halfLife=7 days (decay active)" \
    "DQ-INT-3: KIOKU_DQ_HALFLIFE_DAYS env override surfaces in recency line"

  # invalid env value falls back to default 14 (mirrors resolveDqHalfLifeDays)
  local out_hlbad
  set +e
  out_hlbad="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" KIOKU_DQ_HALFLIFE_DAYS=abc 2>&1)"
  set -e
  assert_contains "${out_hlbad}" "halfLife=14 days (decay active)" \
    "DQ-INT-4: invalid KIOKU_DQ_HALFLIFE_DAYS falls back to default 14"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-HOOK-HEALTH-* (v0.11 S6-4 Layer 2): check_hook_health
#
# errors.log (session-logs/.claude-brain/errors.log) の直近 window 行の WARN
# 件数集計。閾値以上 → warn / 未満 → ok (件数表示) / log 不在 → silent。
# window / threshold は KIOKU_HOOK_WARN_WINDOW / KIOKU_HOOK_WARN_THRESHOLD で
# 可変 (default 200 / 10、injector Layer 3 と共有 — OBS-PARITY-1 が pin)。
# -----------------------------------------------------------------------------

# make_errors_log <vault> <warn_n> [debug_n]: WARN 行 warn_n 件 + DEBUG 行
# debug_n 件 (WARN の後に追記 = より新しい) の synthetic errors.log を作る。
# 実セッションログ raw は使わない (synthetic fixture のみ)。
make_errors_log() {
  local vault="$1"
  local warn_n="$2"
  local debug_n="${3:-0}"
  mkdir -p "${vault}/session-logs/.claude-brain"
  local f="${vault}/session-logs/.claude-brain/errors.log"
  : > "${f}"
  local i
  for ((i = 1; i <= warn_n; i++)); do
    printf '[2026-07-09T00:00:00.000Z] WARN: assistant_stop yielded no text (schema drift / thinking-only / corrupted transcript) session=test-session-hh%d consumedLines=1\n' "${i}" >> "${f}"
  done
  for ((i = 1; i <= debug_n; i++)); do
    printf '[2026-07-09T01:00:00.000Z] DEBUG: handled user_prompt session=test-ses\n' >> "${f}"
  done
}

test_hook_health_warn_over_threshold() {
  echo "BLUE-DOCTOR-HOOK-HEALTH-1: WARN 12 件 (>= default threshold 10) → warn"
  local d
  d="$(new_case "hook-health-over")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  make_errors_log "${d}/vault" 12

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[warn] Hook errors.log: 12 WARN entries in last 200 lines" \
    "HOOK-HEALTH-1: warn line with WARN count over threshold"
  assert_contains "${out}" "hooks may be silently failing" \
    "HOOK-HEALTH-1: warn line explains silent failure risk"
  assert_contains "${out}" 'tail -50 "${OBSIDIAN_VAULT}/session-logs/.claude-brain/errors.log"' \
    "HOOK-HEALTH-1: next action points at errors.log"
}

test_hook_health_below_threshold() {
  echo "BLUE-DOCTOR-HOOK-HEALTH-2: WARN 2 件 (< default threshold 10) → ok (件数表示)"
  local d
  d="$(new_case "hook-health-below")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  make_errors_log "${d}/vault" 2

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_contains "${out}" "[ok]   Hook errors.log: 2 WARN entries in last 200 lines (below threshold 10)" \
    "HOOK-HEALTH-2: ok line with WARN count below threshold"
  assert_not_contains "${out}" "[warn] Hook errors.log" \
    "HOOK-HEALTH-2: no warn line below threshold"
}

test_hook_health_absent_log_silent() {
  echo "BLUE-DOCTOR-HOOK-HEALTH-3: errors.log 不在 → silent (healthy default)"
  local d
  d="$(new_case "hook-health-absent")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  local out
  set +e
  out="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  set -e

  assert_not_contains "${out}" "Hook errors.log" \
    "HOOK-HEALTH-3: no hook-health line when errors.log is absent"
}

test_hook_health_window_and_threshold_env() {
  echo "BLUE-DOCTOR-HOOK-HEALTH-4: KIOKU_HOOK_WARN_WINDOW / _THRESHOLD env override"
  local d
  d="$(new_case "hook-health-env")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"

  # 4a: WARN 5 件の後に DEBUG 10 行 → window=10 では WARN が window 外
  make_errors_log "${d}/vault" 5 10
  local out_win
  set +e
  out_win="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" KIOKU_HOOK_WARN_WINDOW=10 2>&1)"
  set -e
  assert_contains "${out_win}" "[ok]   Hook errors.log: no WARN entries in last 10 lines" \
    "HOOK-HEALTH-4a: old WARN entries outside the window are not counted"

  # 4b: WARN 5 件のみ + threshold=3 → warn
  make_errors_log "${d}/vault" 5
  local out_th
  set +e
  out_th="$(run_doctor "${d}" OBSIDIAN_VAULT="${d}/vault" KIOKU_HOOK_WARN_THRESHOLD=3 2>&1)"
  set -e
  assert_contains "${out_th}" "[warn] Hook errors.log: 5 WARN entries in last 200 lines (>= threshold 3" \
    "HOOK-HEALTH-4b: lowered threshold via env triggers warn"
}

# -----------------------------------------------------------------------------
# BLUE-DOCTOR-QUICK-* (v0.11 S6-6): --quick / quick-start-check
#
# --quick は 3 check のみ (quick-session-log / quick-wiki / quick-mcp-config)。
# network probe (curl) / git 操作 / install mode 判定は走らない。
# -----------------------------------------------------------------------------
test_quick_healthy() {
  echo "BLUE-DOCTOR-QUICK-1: healthy quick state → 3 [ok] + exit 0 (network/git/mode なし)"
  local d
  d="$(new_case "quick-healthy")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault_with_commit "${d}/vault"
  # 24h 以内の session log + wiki 1 md + Codex MCP config (kioku 登録)
  touch "${d}/vault/session-logs/20260709-000000-abcd-fresh.md"
  echo "# index" > "${d}/vault/wiki/index.md"
  mkdir -p "${d}/home/.codex"
  cat >"${d}/home/.codex/config.toml" <<'EOF'
[mcp_servers.kioku]
command = "node"
args = ["/x/server.mjs"]
EOF

  local out
  set +e
  out="$(run_doctor_quick "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "KIOKU Doctor (quick)" "QUICK-1: quick header"
  assert_contains "${out}" "[ok]   session-logs/ has a log written within 24h" \
    "QUICK-1: quick-session-log ok"
  assert_contains "${out}" "[ok]   wiki/ has at least one .md" \
    "QUICK-1: quick-wiki ok"
  assert_contains "${out}" "[ok]   MCP config registers KIOKU: Codex config.toml" \
    "QUICK-1: quick-mcp-config ok (config-level)"
  assert_contains "${out}" "Summary: 3 ok / 0 warn / 0 fail" \
    "QUICK-1: exactly 3 checks in summary"
  assert_eq "0" "${rc}" "QUICK-1: exit 0"
  # 30 秒制約: network / git / install mode 系が quick で走らないことを pinning
  # (vault は git repo + commit 済なので、走っていれば必ず出力に現れる)
  assert_not_contains "${out}" "Network:" "QUICK-1: no network probe in quick"
  assert_not_contains "${out}" "Last Vault commit:" "QUICK-1: no git log check in quick"
  assert_not_contains "${out}" "[mode]" "QUICK-1: no install mode block in quick"
}

test_quick_stale_log_and_empty_wiki() {
  echo "BLUE-DOCTOR-QUICK-2: session log >24h + wiki empty → 2 warn + exit 2"
  local d
  d="$(new_case "quick-stale")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  # session log は 2026-01-01 の stale file のみ、wiki/ は empty のまま
  touch -t 202601010000 "${d}/vault/session-logs/20260101-old.md"
  mkdir -p "${d}/home/.codex"
  cat >"${d}/home/.codex/config.toml" <<'EOF'
[mcp_servers.kioku]
command = "node"
EOF

  local out
  set +e
  out="$(run_doctor_quick "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[warn] session-logs/ has no log newer than 24h" \
    "QUICK-2: stale session log → warn"
  assert_contains "${out}" "[warn] wiki/ has no .md yet" \
    "QUICK-2: empty wiki → warn"
  assert_eq "2" "${rc}" "QUICK-2: exit 2 (warn only)"
}

test_quick_mcp_not_registered() {
  echo "BLUE-DOCTOR-QUICK-3: MCP config はあるが kioku 未登録 → fail + 新 path hint"
  local d
  d="$(new_case "quick-mcp-fail")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  touch "${d}/vault/session-logs/20260709-000000-abcd-fresh.md"
  echo "# index" > "${d}/vault/wiki/index.md"
  mkdir -p "${d}/home/.codex"
  cat >"${d}/home/.codex/config.toml" <<'EOF'
[mcp_servers.other]
command = "node"
EOF

  local out
  set +e
  out="$(run_doctor_quick "${d}" OBSIDIAN_VAULT="${d}/vault" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] MCP client config(s) found but none registers KIOKU" \
    "QUICK-3: kioku 未登録 config → fail"
  assert_contains "${out}" "bash scripts/install/internal/install-mcp-client.sh --apply" \
    "QUICK-3: hint は S6-5 新階層 path"
  assert_eq "1" "${rc}" "QUICK-3: exit 1 (fail)"
}

test_quick_vault_unset() {
  echo "BLUE-DOCTOR-QUICK-4: OBSIDIAN_VAULT 未設定でも常に 3 項目 (invariant)"
  local d
  d="$(new_case "quick-unset")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"

  local out
  set +e
  out="$(run_doctor_quick "${d}" 2>&1)"
  local rc=$?
  set -e

  assert_contains "${out}" "[fail] OBSIDIAN_VAULT is not set — cannot check session-logs/" \
    "QUICK-4: session-log check は vault 未設定を fail 報告"
  assert_contains "${out}" "[fail] OBSIDIAN_VAULT is not set — cannot check wiki/" \
    "QUICK-4: wiki check は vault 未設定を fail 報告"
  # HOME 配下に MCP config が 1 つも無い → warn (常に 3 行 invariant の 3 行目)
  assert_contains "${out}" "Summary: 0 ok / 1 warn / 2 fail" \
    "QUICK-4: 3 項目 invariant (2 fail + 1 warn)"
  assert_eq "1" "${rc}" "QUICK-4: exit 1"
}

test_quick_json() {
  echo "BLUE-DOCTOR-QUICK-5: --quick --json → 3 checks の valid JSON"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  skip  jq not available"
    return 0
  fi
  local d
  d="$(new_case "quick-json")"
  stub_full_clis "${d}/bin"
  stub_node_18 "${d}/bin"
  init_full_vault "${d}/vault"
  touch "${d}/vault/session-logs/20260709-000000-abcd-fresh.md"
  echo "# index" > "${d}/vault/wiki/index.md"
  mkdir -p "${d}/home/.codex"
  cat >"${d}/home/.codex/config.toml" <<'EOF'
[mcp_servers.kioku]
command = "node"
EOF

  local out
  set +e
  out="$(run_doctor_quick_json "${d}" OBSIDIAN_VAULT="${d}/vault" 2>/dev/null)"
  local rc=$?
  set -e

  local valid
  valid="$(printf '%s' "${out}" | jq -r 'type' 2>/dev/null || echo "invalid")"
  assert_eq "object" "${valid}" "QUICK-5: --quick --json は valid JSON object"

  local checks_len ok_count ids
  checks_len="$(printf '%s' "${out}" | jq -r '.checks | length' 2>/dev/null || echo "?")"
  ok_count="$(printf '%s' "${out}" | jq -r '.summary.ok' 2>/dev/null || echo "?")"
  ids="$(printf '%s' "${out}" | jq -r '[.checks[].id] | join(",")' 2>/dev/null || echo "?")"
  assert_eq "3" "${checks_len}" "QUICK-5: checks は 3 件"
  assert_eq "3" "${ok_count}" "QUICK-5: summary.ok = 3"
  assert_eq "quick-session-log,quick-wiki,quick-mcp-config" "${ids}" \
    "QUICK-5: check id は quick-* 3 種 (この順)"
  assert_eq "0" "${rc}" "QUICK-5: exit 0"
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
test_install_mode_full
test_install_mode_mcp_only
test_install_mode_unknown
test_install_mode_json
test_sync_state_integrated
test_auto_ingest_state_integrated
test_hook_health_warn_over_threshold
test_hook_health_below_threshold
test_hook_health_absent_log_silent
test_hook_health_window_and_threshold_env
test_discoverqueries_state_integrated
test_quick_healthy
test_quick_stale_log_and_empty_wiki
test_quick_mcp_not_registered
test_quick_vault_unset
test_quick_json

echo ""
echo "doctor.test.sh: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
exit 0
