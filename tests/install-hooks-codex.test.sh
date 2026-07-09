#!/usr/bin/env bash
#
# tests/install-hooks-codex.test.sh — v0.7.0 Q2 Codex install-hooks test
#
# Test prefixes:
#   - IH-CODEX-*              : config shape / feature flag / idempotency
#   - IH-CODEX-GIT-SYNC-1..2  : PM A1 指示の 2 段 hook + skip-on-no-changes 動作 verify

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install/user/install-hooks-codex.sh"
INSTALLER_CLAUDE="${REPO_ROOT}/scripts/install/user/install-hooks.sh"

fail_count=0
fail() { echo "FAIL: $*" >&2 ; fail_count=$((fail_count + 1)); }
ok() { echo "OK: $*"; }

TMPDIR_SAFE="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_SAFE}"' EXIT
export OBSIDIAN_VAULT="${TMPDIR_SAFE}/vault"
mkdir -p "${OBSIDIAN_VAULT}"
export CODEX_HOOKS_FILE="${TMPDIR_SAFE}/.codex/hooks.json"
export CODEX_CONFIG_FILE="${TMPDIR_SAFE}/.codex/config.toml"

# -----------------------------------------------------------------------------
# IH-CODEX-1: --apply で生成される hooks.json に 4 event key 全部存在
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
for key in SessionStart UserPromptSubmit PostToolUse Stop; do
  if jq -e ".hooks[\"${key}\"]" "${CODEX_HOOKS_FILE}" >/dev/null 2>&1; then
    ok "IH-CODEX-1: event key '${key}' present"
  else
    fail "IH-CODEX-1: event key '${key}' missing"
  fi
done

# SessionEnd は Codex に無いので config にも無いこと
if jq -e '.hooks.SessionEnd' "${CODEX_HOOKS_FILE}" >/dev/null 2>&1; then
  fail "IH-CODEX-1: SessionEnd key should NOT be present (Codex has no SessionEnd)"
else
  ok "IH-CODEX-1: SessionEnd correctly absent (Codex has no such event)"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-2: feature flag が config.toml に設定される
# -----------------------------------------------------------------------------
if grep -q "codex_hooks = true" "${CODEX_CONFIG_FILE}" 2>/dev/null; then
  ok "IH-CODEX-2: feature flag codex_hooks=true set in config.toml"
else
  fail "IH-CODEX-2: feature flag not set in ${CODEX_CONFIG_FILE}"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-3: idempotent (2 回 --apply で重複しない)
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
user_prompt_count=$(jq '.hooks.UserPromptSubmit | length' "${CODEX_HOOKS_FILE}")
if [[ "${user_prompt_count}" == "1" ]]; then
  ok "IH-CODEX-3: idempotent (UserPromptSubmit has 1 entry after 2 runs)"
else
  fail "IH-CODEX-3: UserPromptSubmit has ${user_prompt_count} entries"
fi
# config.toml の codex_hooks = true も 1 回だけ
flag_count=$(grep -c "codex_hooks = true" "${CODEX_CONFIG_FILE}")
if [[ "${flag_count}" == "1" ]]; then
  ok "IH-CODEX-3: feature flag appears exactly once"
else
  fail "IH-CODEX-3: feature flag appears ${flag_count} times"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-3-SF-A (PR #56 review): --apply 3 回目でも全 event key が 1 entry
# matcher-wrapped (SessionStart / PostToolUse) / non-matcher (UserPromptSubmit / Stop) 両形態 pass
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
for key in SessionStart UserPromptSubmit PostToolUse Stop; do
  cnt=$(jq ".hooks.${key} | length" "${CODEX_HOOKS_FILE}")
  if [[ "${cnt}" == "1" ]]; then
    ok "IH-CODEX-3-SF-A: ${key} has 1 entry after 3 --apply runs (dedup works for matcher-wrapped + non-matcher)"
  else
    fail "IH-CODEX-3-SF-A: ${key} has ${cnt} entries (expected 1) — dedup broken?"
  fi
done

# -----------------------------------------------------------------------------
# IH-CODEX-4: PostToolUse matcher は Bash のみ (Codex 実装と整合)
# -----------------------------------------------------------------------------
matcher="$(jq -r '.hooks.PostToolUse[0].matcher' "${CODEX_HOOKS_FILE}")"
if [[ "${matcher}" == "Bash" ]]; then
  ok "IH-CODEX-4: PostToolUse matcher is 'Bash' only"
else
  fail "IH-CODEX-4: PostToolUse matcher unexpected: ${matcher}"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-GIT-SYNC-1 (PM A1): Stop event に 2 段 hook
# (1) adapter 実行、(2) git-sync shell one-liner
# -----------------------------------------------------------------------------
stop_hooks_count=$(jq '.hooks.Stop[0].hooks | length' "${CODEX_HOOKS_FILE}")
if [[ "${stop_hooks_count}" == "2" ]]; then
  ok "IH-CODEX-GIT-SYNC-1: Stop has 2-stage hook (adapter + git-sync shell)"
else
  fail "IH-CODEX-GIT-SYNC-1: Stop has ${stop_hooks_count} hooks (expected 2)"
fi

stage1_cmd="$(jq -r '.hooks.Stop[0].hooks[0].command' "${CODEX_HOOKS_FILE}")"
stage2_cmd="$(jq -r '.hooks.Stop[0].hooks[1].command' "${CODEX_HOOKS_FILE}")"

if [[ "${stage1_cmd}" == *"hooks/adapters/codex.mjs"* ]]; then
  ok "IH-CODEX-GIT-SYNC-1: stage 1 invokes codex adapter"
else
  fail "IH-CODEX-GIT-SYNC-1: stage 1 unexpected: ${stage1_cmd}"
fi

if [[ "${stage2_cmd}" == *"sync-vault.mjs"*"--push"* ]]; then
  ok "IH-CODEX-GIT-SYNC-1: stage 2 sync-vault.mjs --push invocation present"
else
  fail "IH-CODEX-GIT-SYNC-1: stage 2 missing expected sync-vault.mjs --push invocation"
fi

# single source of truth check (PM A3 指示): install-hooks.sh Claude SessionEnd
# stage 2 と byte-identical であること
# S6-5: install-hooks.sh は Mode A 環境 (dev 機の実 ~/.claude) で Mode gate が
# 発火するため --force を付けて snippet を取得する (gate は install-hierarchy.test.sh が検証)
claude_stage2="$(OBSIDIAN_VAULT="${OBSIDIAN_VAULT}" bash "${INSTALLER_CLAUDE}" --force 2>/dev/null | awk '/^{/,/^}$/' | jq -r '.hooks.SessionEnd[1].hooks[0].command')"
if [[ "${claude_stage2}" == "${stage2_cmd}" ]]; then
  ok "IH-CODEX-GIT-SYNC-1: stage 2 command byte-identical to install-hooks.sh Claude SessionEnd (single source of truth)"
else
  fail "IH-CODEX-GIT-SYNC-1: stage 2 diverged from Claude SessionEnd snippet"
  echo "  claude: ${claude_stage2}" >&2
  echo "  codex : ${stage2_cmd}" >&2
fi

# --allow-empty が使われていないこと (空コミット発生しない保証)
if [[ "${stage2_cmd}" == *"--allow-empty"* ]]; then
  fail "IH-CODEX-GIT-SYNC-1: stage 2 uses --allow-empty (must not)"
else
  ok "IH-CODEX-GIT-SYNC-1: stage 2 does NOT use --allow-empty (skip-on-no-changes 保証)"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-GIT-SYNC-2 (PM A1): 実動作 verify — wiki/ 無変更の Stop 発火で
# 空コミット発生しないこと
# -----------------------------------------------------------------------------
# 実 git repo の Vault を作る
cd "${OBSIDIAN_VAULT}"
git init --quiet -b main
git config user.email "test@example.com"
git config user.name "Test User"
# .gitignore + 初期 commit (session-logs/ が .gitignore に入っている必要あり、
# install-hooks.sh の gitignore grep guard 条件)
cat > .gitignore <<EOT
session-logs/
.obsidian/
EOT
mkdir -p wiki raw-sources templates
echo "initial" > wiki/hot.md
echo "repo README" > CLAUDE.md
git add -A
git commit -q -m "initial"

initial_commits=$(git log --oneline | wc -l | tr -d ' ')

# git-sync command を 3 回実行 (変更なし)
# git push は無い remote で fail するが `|| true` と `2>/dev/null` で吸収される
for i in 1 2 3; do
  # shellcheck disable=SC2016  # 意図的に literal 文字列で eval
  eval "${stage2_cmd}"
done

final_commits=$(git log --oneline | wc -l | tr -d ' ')

if [[ "${final_commits}" == "${initial_commits}" ]]; then
  ok "IH-CODEX-GIT-SYNC-2: no empty commits (${initial_commits} before / ${final_commits} after 3 runs with no changes)"
else
  fail "IH-CODEX-GIT-SYNC-2: commits created despite no changes (${initial_commits} → ${final_commits})"
fi

# 実変更ありの場合は commit される (sanity check、push 失敗は許容)
echo "new content" > wiki/newnote.md
# shellcheck disable=SC2016
eval "${stage2_cmd}"
after_change_commits=$(git log --oneline | wc -l | tr -d ' ')
if [[ "${after_change_commits}" == "$((initial_commits + 1))" ]]; then
  ok "IH-CODEX-GIT-SYNC-2: real change → 1 commit added (${initial_commits} → ${after_change_commits})"
else
  fail "IH-CODEX-GIT-SYNC-2: real change did not produce exactly 1 commit"
fi

# -----------------------------------------------------------------------------
# IH-CODEX-5: adapter path は codex.mjs (session-logger / gemini ではない)
# -----------------------------------------------------------------------------
user_prompt_cmd="$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "${CODEX_HOOKS_FILE}")"
if [[ "${user_prompt_cmd}" == *"hooks/adapters/codex.mjs"* ]]; then
  ok "IH-CODEX-5: UserPromptSubmit references adapters/codex.mjs"
else
  fail "IH-CODEX-5: UserPromptSubmit cmd: ${user_prompt_cmd}"
fi

# -----------------------------------------------------------------------------
# 結果
# -----------------------------------------------------------------------------
if [[ ${fail_count} -gt 0 ]]; then
  echo "IH-CODEX: FAILED (${fail_count} issue(s))" >&2
  exit 1
fi
echo "IH-CODEX: all checks passed"
