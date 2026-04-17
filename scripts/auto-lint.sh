#!/usr/bin/env bash
#
# auto-lint.sh — KIOKU 自動 Lint スクリプト (Phase G)
#
# cron から呼び出され、wiki/ の健全性レポートを wiki/lint-report.md に出力する。
# レポート生成のみ。自動修正はしない (--allowedTools に Edit を含めない)。
#
# 環境変数:
#   OBSIDIAN_VAULT   Vault ルート (未設定時は $HOME/kioku/main-kioku)
#   KIOKU_DRY_RUN=1  claude -p を呼ばず、コマンドをログ出力するだけ (テスト用)
#
# 終了コード:
#   0  正常終了 (ページ 0 件のスキップも含む)
#   1  Vault が存在しない / claude コマンドが PATH にない
#
# 使用例 (crontab):
#   0 8 1 * * /ABS/PATH/to/auto-lint.sh >> "$HOME/kioku-lint.log" 2>&1

set -euo pipefail

LOG_PREFIX="[auto-lint $(date +%Y%m%d-%H%M)]"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

OBSIDIAN_VAULT="${OBSIDIAN_VAULT:-${HOME}/kioku/main-kioku}"

# R4-001: OBSIDIAN_VAULT のバリデーション
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "${LOG_PREFIX} ERROR: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}
validate_vault_path "${OBSIDIAN_VAULT}"

# Volta 管理下のバイナリ (~/.volta/bin) と mise shims (~/.local/share/mise/shims) も含める。
#
# 重要: mise shims を Volta より **前** に置く。qmd は mise の Node 22 に対して
# native module (better-sqlite3) をビルドしているため、Volta 上の別バージョンの
# Node が PATH 先頭にあると ABI mismatch でクラッシュする。
# claude (Volta 管理) は mise shim 上に存在しないため引き続き Volta から見つかる。
export PATH="${HOME}/.local/share/mise/shims:${HOME}/.volta/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  echo "${LOG_PREFIX} ERROR: OBSIDIAN_VAULT not found: ${OBSIDIAN_VAULT}" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "${LOG_PREFIX} ERROR: claude command not found in PATH" >&2
  exit 1
fi

# VULN-011: PATH 上のバイナリが所有者以外に書き込み可能でないか検証
# NEW-005: ls -ln + awk で POSIX ポータブルに (macOS / Linux 両対応)
for bin_name in claude node; do
  bin_path="$(command -v "${bin_name}" 2>/dev/null || true)"
  if [[ -n "${bin_path}" ]] && [[ -w "${bin_path}" ]]; then
    owner_uid="$(ls -ln "${bin_path}" 2>/dev/null | awk '{print $3}')"
    if [[ -n "${owner_uid}" ]] && [[ "${owner_uid}" != "$(id -u)" ]]; then
      echo "${LOG_PREFIX} WARNING: ${bin_name} at ${bin_path} is writable by non-owner" >&2
    fi
  fi
done

# -----------------------------------------------------------------------------
# Wiki ページ数の確認 (index.md / log.md / lint-report.md は対象外)
# -----------------------------------------------------------------------------

WIKI_DIR="${OBSIDIAN_VAULT}/wiki"
if [[ ! -d "${WIKI_DIR}" ]]; then
  echo "${LOG_PREFIX} No wiki directory yet. Skipping."
  exit 0
fi

WIKI_PAGES=0
while IFS= read -r _; do
  WIKI_PAGES=$((WIKI_PAGES + 1))
done < <(
  find "${WIKI_DIR}" -type f -name "*.md" \
    ! -name "index.md" ! -name "log.md" ! -name "lint-report.md" 2>/dev/null
)

if [[ "${WIKI_PAGES}" == "0" ]]; then
  echo "${LOG_PREFIX} Wiki has no content pages yet. Skipping lint."
  exit 0
fi

echo "${LOG_PREFIX} Found ${WIKI_PAGES} wiki page(s). Starting lint..."

# -----------------------------------------------------------------------------
# Git pull (最新の wiki をチェック対象にする)
# -----------------------------------------------------------------------------

cd "${OBSIDIAN_VAULT}"
git pull --rebase --quiet 2>/dev/null || true

# -----------------------------------------------------------------------------
# Lint プロンプト
# -----------------------------------------------------------------------------

read -r -d '' LINT_PROMPT <<'PROMPT' || true
CLAUDE.md のスキーマに従って、wiki/ 内の全ファイルを読んで健全性をチェックして。

以下の観点で問題を探して:
1. ページ間の矛盾 (同じ事実について異なる記述がないか)
2. 孤立ページ (他のどのページからもリンクされていないページ)
3. 繰り返し言及されるが専用ページのない概念
4. 新しいソースで上書きされた古い主張
5. 不足している相互リンク
6. フロントマターの不備 (tags, updated 等の欠損)

重要: 問題の修正は行わないこと。レポートの生成のみ。

出力先: wiki/lint-report.md
フォーマット:
---
title: Lint Report
date: (今日の日付)
---

# Wiki Lint Report (YYYY-MM-DD)

## 要約
- 検出した問題の総数
- カテゴリ別の内訳

## 矛盾
(矛盾があれば具体的なページ名と内容を列挙)

## 孤立ページ
(リンクされていないページの一覧)

## 専用ページ候補
(頻出だが専用ページのない概念)

## 古い記述の疑い
(新しい情報で上書きされた可能性のある記述)

## リンク不足
(相互リンクを追加すべき箇所)

## フロントマター不備
(不備のあるページ一覧)
PROMPT

# -----------------------------------------------------------------------------
# Lint 実行 (テストで mock 可能なように関数化)
# Write だけ許可。Edit は許可しない = Wiki の既存ファイルを修正できない。
# -----------------------------------------------------------------------------

run_lint() {
  if [[ "${KIOKU_DRY_RUN:-0}" == "1" ]]; then
    echo "${LOG_PREFIX} DRY RUN: would call claude -p with prompt len=${#LINT_PROMPT}"
    # DRY RUN 時もレポートファイルの存在確認テストのためダミーを書く
    mkdir -p "${WIKI_DIR}"
    printf -- '---\ntitle: Lint Report (dry run)\ndate: %s\n---\n' "$(date +%Y-%m-%d)" \
      > "${WIKI_DIR}/lint-report.md"
    return 0
  fi
  # KIOKU_NO_LOG=1 でサブプロセス側 Hook を no-op 化 (再帰ログ防止)。
  KIOKU_NO_LOG=1 claude -p "${LINT_PROMPT}" \
    --allowedTools Write,Read \
    --max-turns 30
}

run_lint

# -----------------------------------------------------------------------------
# lint-report.md を commit & push
# DRY RUN 時はスキップ (stub をコミットしないため)。
# Vault が git リポジトリでなければもスキップ。
# -----------------------------------------------------------------------------

if [[ "${KIOKU_DRY_RUN:-0}" == "1" ]]; then
  echo "${LOG_PREFIX} DRY RUN: skipping git commit/push."
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # R4-006: .gitignore に session-logs/ が含まれていることを確認してから git 操作
  if ! grep -q '^session-logs/' .gitignore 2>/dev/null; then
    echo "${LOG_PREFIX} WARNING: .gitignore missing 'session-logs/' entry. Skipping git commit/push for safety." >&2
  else
    git add wiki/lint-report.md 2>/dev/null || true
    if git diff --cached --quiet 2>/dev/null; then
      echo "${LOG_PREFIX} No changes to lint report."
    else
      git commit -m "auto-lint: report $(date +%Y%m%d)" --quiet 2>/dev/null || true
      git push --quiet 2>/dev/null || true
      echo "${LOG_PREFIX} Lint report generated and pushed."
    fi
  fi
else
  echo "${LOG_PREFIX} Vault is not a git repository. Skipping commit/push."
fi

# -----------------------------------------------------------------------------
# Phase J: qmd インデックス更新 (インストール済みの場合のみ)
#
# Lint レポートも qmd の検索対象に含めるため、ここで再インデックスする。
# qmd 未インストール時は何もしない (オプション依存)。
# -----------------------------------------------------------------------------

if command -v qmd >/dev/null 2>&1; then
  echo "${LOG_PREFIX} Updating qmd index..."
  qmd update >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd update failed"
  qmd embed  >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd embed failed"
else
  echo "${LOG_PREFIX} qmd not installed; skipping index update."
fi

# -----------------------------------------------------------------------------
# 自己診断セクション (open-issues #4 / #5 / #6 統合)
#
# - 月次 lint の末尾で 3 種の健全性チェックをまとめて実行し、stdout に要約する。
# - 結果は $HOME/kioku-lint.log (cron リダイレクト先) に残るため、
#   ユーザーは月 1 度ログを覗くだけで以下を把握できる:
#     1. auto-ingest が max_turns 上限に達したか (#4)
#     2. wiki/lint-report.md が新規に何件の問題を報告したか (#5)
#     3. session-logs/ に秘密情報の漏れがあるか (#6)
# - 診断自体は情報提示のみで、exit code は失敗扱いしない (既存の cron 挙動維持)。
# -----------------------------------------------------------------------------

run_self_diagnostics() {
  echo "${LOG_PREFIX} --- self-diagnostics ---"

  # (1) auto-ingest の max_turns 到達を検知
  # KIOKU_INGEST_LOG で差し替え可能 (テスト用)。デフォルトは cron のリダイレクト先。
  local ingest_log="${KIOKU_INGEST_LOG:-${HOME}/kioku-ingest.log}"
  if [[ -f "${ingest_log}" ]]; then
    local max_turn_hits
    max_turn_hits=$(grep -ciE 'max.?turns?' "${ingest_log}" 2>/dev/null || true)
    max_turn_hits="${max_turn_hits:-0}"
    if [[ "${max_turn_hits}" -gt 0 ]]; then
      echo "${LOG_PREFIX} [#4] WARNING: 'max turns' mentioned ${max_turn_hits} time(s) in ${ingest_log}"
      echo "${LOG_PREFIX} [#4] Consider raising --max-turns in auto-ingest.sh."
    else
      echo "${LOG_PREFIX} [#4] OK: no max_turns saturation in ingest log."
    fi
  else
    echo "${LOG_PREFIX} [#4] SKIP: ingest log not found at ${ingest_log}"
  fi

  # (2) lint-report.md の問題総数を抽出
  #
  # プロンプト仕様上、レポートには「## 要約」と「検出した問題の総数」が書かれる。
  # Claude の出力ゆれを許容するため、数値を含む行を幅広く拾う。
  local report_file="${WIKI_DIR}/lint-report.md"
  if [[ -f "${report_file}" ]]; then
    # 「要約」セクション直下から数値を取る素朴な抽出。見つからなければ件数不明扱い。
    local summary_line
    summary_line=$(grep -m1 -iE '(検出|合計|total|問題の総数|問題数)' "${report_file}" 2>/dev/null || true)
    if [[ -n "${summary_line}" ]]; then
      echo "${LOG_PREFIX} [#5] lint-report.md summary: ${summary_line}"
    else
      local line_count
      line_count=$(wc -l < "${report_file}" | tr -d ' ')
      echo "${LOG_PREFIX} [#5] lint-report.md exists (${line_count} lines). Review in Obsidian."
    fi
  else
    echo "${LOG_PREFIX} [#5] SKIP: lint-report.md not generated yet."
  fi

  # (3) scan-secrets.sh で session-logs/ の漏れを検知
  #
  # スクリプトは存在チェックで optional 扱い (兄弟スクリプトが動いていない環境でも
  # auto-lint を壊さないため)。
  local scan_script="${SCRIPT_DIR}/scan-secrets.sh"
  if [[ -f "${scan_script}" ]]; then
    set +e
    local scan_out
    scan_out=$(OBSIDIAN_VAULT="${OBSIDIAN_VAULT}" bash "${scan_script}" 2>&1)
    local scan_rc=$?
    set -e
    case "${scan_rc}" in
      0)
        echo "${LOG_PREFIX} [#6] OK: session-logs/ clean."
        ;;
      2)
        echo "${LOG_PREFIX} [#6] WARNING: secret-like patterns detected in session-logs/"
        printf '%s\n' "${scan_out}" | sed "s/^/${LOG_PREFIX} [#6]   /"
        ;;
      *)
        echo "${LOG_PREFIX} [#6] SKIP: scan-secrets.sh exit ${scan_rc} (vault or session-logs/ missing)"
        ;;
    esac
  else
    echo "${LOG_PREFIX} [#6] SKIP: scan-secrets.sh not found at ${scan_script}"
  fi

  echo "${LOG_PREFIX} --- end diagnostics ---"
}

# DRY RUN でも診断は走らせて経路を確認する (副作用がないため)。
run_self_diagnostics

echo "${LOG_PREFIX} Done. Review wiki/lint-report.md in Obsidian."
