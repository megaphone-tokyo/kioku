#!/usr/bin/env bash
#
# auto-ingest.sh — claude-brain 自動 Ingest スクリプト (Phase F)
#
# cron から呼び出され、session-logs/ の未処理ログ (ingested: false) を
# claude -p 経由で wiki/ に取り込む。Ingest 後に git add/commit/push する。
#
# 環境変数:
#   OBSIDIAN_VAULT   Vault ルート (未設定時は $HOME/claude-brain/main-claude-brain)
#   KIOKU_DRY_RUN=1  claude -p を呼ばず、コマンドをログ出力するだけ (テスト用)
#
# 終了コード:
#   0  正常終了 (未処理ログ 0 件のスキップも含む)
#   1  Vault が存在しない / claude コマンドが PATH にない
#
# 使用例 (crontab):
#   0 7 * * * /ABS/PATH/to/auto-ingest.sh >> "$HOME/kioku-ingest.log" 2>&1

set -euo pipefail

LOG_PREFIX="[auto-ingest $(date +%Y%m%d-%H%M)]"

# cron 環境では ~/.zshrc / ~/.zprofile が読まれないため、明示的に補完する。
OBSIDIAN_VAULT="${OBSIDIAN_VAULT:-${HOME}/claude-brain/main-claude-brain}"

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

# claude / node / git が PATH に含まれない cron 環境に備える。
# Volta 管理下のバイナリ (~/.volta/bin) と mise shims (~/.local/share/mise/shims) も含める。
#
# 重要: mise shims を Volta より **前** に置く。qmd は mise の Node 22 に対して
# native module (better-sqlite3) をビルドしているため、Volta 上の別バージョンの
# Node が PATH 先頭にあると ABI mismatch でクラッシュする。
# mise shim は親 PATH 上の `node` をそのまま使うので順序で吸収する。
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
# 未処理ソースの確認 (session-logs/ と raw-sources/ の両方)
# -----------------------------------------------------------------------------

SESSION_LOGS_DIR="${OBSIDIAN_VAULT}/session-logs"
RAW_SOURCES_DIR="${OBSIDIAN_VAULT}/raw-sources"
SUMMARIES_DIR="${OBSIDIAN_VAULT}/wiki/summaries"

if [[ ! -d "${SESSION_LOGS_DIR}" ]] && [[ ! -d "${RAW_SOURCES_DIR}" ]]; then
  echo "${LOG_PREFIX} Neither session-logs nor raw-sources directory exists. Skipping."
  exit 0
fi

# `ingested: false` を含む session-log ファイル数をカウント。
# session-logs/ 直下の *.md のみ対象 (.claude-brain/ 等のサブディレクトリは除外)。
UNPROCESSED_LOGS=0
if [[ -d "${SESSION_LOGS_DIR}" ]]; then
  shopt -s nullglob
  for f in "${SESSION_LOGS_DIR}"/*.md; do
    if grep -q "^ingested: false" "${f}" 2>/dev/null; then
      UNPROCESSED_LOGS=$((UNPROCESSED_LOGS + 1))
    fi
  done
  shopt -u nullglob
fi

# raw-sources/<subdir>/<name>.md に対応する wiki/summaries/<subdir>-<name>.md が
# 存在しないものをカウント。(raw-sources は読み取り専用なので flag は持てない)
# macOS 標準 bash 3.2 には globstar がないため find を使う。
UNPROCESSED_SOURCES=0
if [[ -d "${RAW_SOURCES_DIR}" ]]; then
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    rel="${f#${RAW_SOURCES_DIR}/}"                # articles/foo.md
    # サブディレクトリ直下でないファイルはスキップ (念のため)
    [[ "${rel}" != */* ]] && continue
    subdir="${rel%%/*}"                            # articles
    name="${rel#*/}"                               # foo.md (深いパスでも OK)
    flat_name="${name//\//-}"                      # さらに深ければ / を - に
    summary="${SUMMARIES_DIR}/${subdir}-${flat_name}"
    if [[ ! -f "${summary}" ]]; then
      UNPROCESSED_SOURCES=$((UNPROCESSED_SOURCES + 1))
    fi
  done < <(find "${RAW_SOURCES_DIR}" -type f -name "*.md" 2>/dev/null)
fi

if [[ "${UNPROCESSED_LOGS}" == "0" ]] && [[ "${UNPROCESSED_SOURCES}" == "0" ]]; then
  echo "${LOG_PREFIX} No unprocessed logs or raw-sources found. Skipping."
  exit 0
fi

echo "${LOG_PREFIX} Found ${UNPROCESSED_LOGS} unprocessed log(s) and ${UNPROCESSED_SOURCES} unprocessed raw-source(s). Starting ingest..."

# -----------------------------------------------------------------------------
# Git pull (最新の wiki を取り込んでからマージする)
# -----------------------------------------------------------------------------

cd "${OBSIDIAN_VAULT}"
git pull --rebase --quiet 2>/dev/null || true

# -----------------------------------------------------------------------------
# Ingest プロンプト
# -----------------------------------------------------------------------------

read -r -d '' INGEST_PROMPT <<'PROMPT' || true
CLAUDE.md のスキーマに従って、session-logs/ にある ingested: false のログを読んで、
重要な設計判断・バグ修正・学んだパターン・技術選択だけを選別して wiki に取り込んで。

以下はスキップしていい:
- lint 修正、フォーマット修正、typo 修正
- 依存関係のバージョン更新 (破壊的変更を伴う場合を除く)
- 探索的な試行錯誤 (最終的な結論だけ残す)

追加の抽出対象 (Phase I):
- セッション中に生成された有用な分析・比較・技術調査の結果
- 「○○と△△の違い」「○○のベストプラクティス」のような汎用的な知見
- これらは wiki/analyses/ にページとして保存すること
- ページ名は内容を表す kebab-case (例: react-vs-vue-comparison.md)
- 特定プロジェクトに閉じない汎用的な知見を優先的に保存する
- 同名のページが既に wiki/analyses/ に存在する場合は新規作成ではなく既存ページを更新すること (重複禁止)
- 保存基準と具体的なページフォーマットは Vault の CLAUDE.md を参照すること

追加の取り込み対象 (Phase M / mcp-note):
- session-logs/ にある type: mcp-note のファイルは、Claude Desktop からユーザーが kioku_write_note 経由で保存したメモ
- 通常の session-log と同列で扱い、wiki/ に構造化して取り込むこと
- type: mcp-note は cwd フィールドが空でもよい (Desktop には対応する作業ディレクトリがない)
- 取り込み後は通常の session-log と同様に ingested: true に更新する

追加の取り込み対象 (raw-sources/):
- raw-sources/ 配下のサブディレクトリ (articles/ books/ ideas/ transcripts/ 等) にある .md ファイルで、まだ対応する wiki/summaries/ ページが作られていないもの
- 対応関係: raw-sources/<subdir>/<name>.md → wiki/summaries/<subdir>-<name>.md (サブディレクトリ名をプレフィックスとして付与し、衝突と重複を防ぐ)
- 既に wiki/summaries/<subdir>-<name>.md が存在する場合はスキップ (重複禁止)。raw-sources/ のファイルが更新されていて内容が変わっている場合のみ既存サマリーを更新すること
- サマリーのフォーマットは templates/notes/source-summary.md または Vault の CLAUDE.md の規約に従う (要約 / 重要なポイント / Wiki への影響)
- 関連する既存 wiki ページには相互リンクを追加 (raw-sources/ からの事実で既存ページを補強または矛盾を指摘)
- raw-sources/ は読み取り専用。raw-sources/ のファイルそのものを編集しないこと

重要: API キー、パスワード、トークン等の秘匿情報は絶対に wiki ページに含めないこと。
重要: wiki/projects/ ページにはフロントマターの cwd フルパスを記載しないこと。プロジェクト名のみ記載する。

処理手順:
1. 該当する wiki ページを更新 (なければ作成)
2. wiki/index.md を更新
3. wiki/log.md に Ingest 記録を追記 (session-logs 由来 / raw-sources 由来を分けて記録)
4. 処理したログの ingested を true に変更 (raw-sources/ は対象外、wiki/summaries/ の有無で判断)
5. 触ったファイルを全部表示して
PROMPT

# -----------------------------------------------------------------------------
# Ingest 実行 (テストで mock 可能なように関数化)
# -----------------------------------------------------------------------------

run_ingest() {
  if [[ "${KIOKU_DRY_RUN:-0}" == "1" ]]; then
    echo "${LOG_PREFIX} DRY RUN: would call claude -p with prompt len=${#INGEST_PROMPT}"
    return 0
  fi
  # KIOKU_NO_LOG=1 でサブプロセス側 Hook を no-op 化 (再帰ログ防止)。
  KIOKU_NO_LOG=1 claude -p "${INGEST_PROMPT}" \
    --allowedTools Write,Read,Edit \
    --max-turns 60
}

run_ingest

# -----------------------------------------------------------------------------
# Ingest 結果を commit & push
# DRY RUN 時はスキップ (raw-sources/ の手動配置等、無関係な変更を巻き込まないため)。
# Vault が git リポジトリでなければも丸ごとスキップ (非破壊的にフェイルセーフ)。
# -----------------------------------------------------------------------------

if [[ "${KIOKU_DRY_RUN:-0}" == "1" ]]; then
  echo "${LOG_PREFIX} DRY RUN: skipping git commit/push."
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # NEW-009: .gitignore に session-logs/ が含まれていることを確認してから git 操作
  if ! grep -q '^session-logs/' .gitignore 2>/dev/null; then
    echo "${LOG_PREFIX} WARNING: .gitignore missing 'session-logs/' entry. Skipping git commit/push for safety." >&2
  else
    git add wiki/ raw-sources/ templates/ CLAUDE.md 2>/dev/null || true
    if git diff --cached --quiet 2>/dev/null; then
      echo "${LOG_PREFIX} No wiki changes to commit."
    else
      git commit -m "auto-ingest: wiki update $(date +%Y%m%d-%H%M)" --quiet 2>/dev/null || true
      git push --quiet 2>/dev/null || true
      echo "${LOG_PREFIX} Wiki updated and pushed."
    fi
  fi
else
  echo "${LOG_PREFIX} Vault is not a git repository. Skipping commit/push."
fi

# -----------------------------------------------------------------------------
# Phase J: qmd インデックス更新 (インストール済みの場合のみ)
#
# Wiki が auto-ingest で更新された直後に qmd の BM25 + ベクトル埋め込みも
# 最新化する。qmd 未インストール時は何もしない (オプション依存)。
# -----------------------------------------------------------------------------

if command -v qmd >/dev/null 2>&1; then
  echo "${LOG_PREFIX} Updating qmd index..."
  qmd update >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd update failed"
  qmd embed  >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd embed failed"
else
  echo "${LOG_PREFIX} qmd not installed; skipping index update."
fi

echo "${LOG_PREFIX} Done."
