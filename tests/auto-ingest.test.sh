#!/usr/bin/env bash
#
# auto-ingest.test.sh — scripts/auto-ingest.sh のスモークテスト
#
# 実行: bash tools/claude-brain/tests/auto-ingest.test.sh
#
# 検証項目 (Phase F.6 / F1〜F5):
#   F1 未処理ログ 0 件 → claude 呼ばず exit 0
#   F2 OBSIDIAN_VAULT が存在しない → exit 1
#   F3 claude コマンドが PATH にない → exit 1
#   F4 未処理ログあり + DRY RUN → claude を呼ぶ経路に到達する
#   F5 非 git vault → Ingest 処理自体は成功 (git は silently fail)
#
# Phase I (wiki/analyses/ 抽出) の追加ケース:
#   I1 INGEST_PROMPT に wiki/analyses/ への保存指示が含まれる
#   I2 INGEST_PROMPT に kebab-case ファイル名指示と汎用知見優先の指示が含まれる
#   I3 INGEST_PROMPT に「同名ページは更新 (重複禁止)」の指示が含まれる

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
AUTO_INGEST="${REPO_ROOT}/tools/claude-brain/scripts/auto-ingest.sh"

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
# stub claude バイナリ (F1, F4, F5 で使う)
# -----------------------------------------------------------------------------
STUB_DIR="${TMPROOT}/stub-bin"
mkdir -p "${STUB_DIR}"
cat > "${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
# Test stub: record invocation args, never call real API
echo "stub-claude called with $# args" >&2
exit 0
STUB
chmod +x "${STUB_DIR}/claude"

# -----------------------------------------------------------------------------
# 有効な vault を作るヘルパー
# -----------------------------------------------------------------------------
make_vault() {
  local name="$1"
  local vault="${TMPROOT}/${name}"
  mkdir -p "${vault}/session-logs" "${vault}/wiki" "${vault}/raw-sources" "${vault}/templates"
  : > "${vault}/CLAUDE.md"
  echo "${vault}"
}

add_unprocessed_log() {
  local vault="$1"
  local name="$2"
  cat > "${vault}/session-logs/${name}.md" <<EOF
---
type: session-log
session_id: ${name}
ingested: false
---

body
EOF
}

# -----------------------------------------------------------------------------
# Test F2: OBSIDIAN_VAULT が存在しない → exit 1
# -----------------------------------------------------------------------------
echo "test F2: missing OBSIDIAN_VAULT -> exit 1"
set +e
(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${TMPROOT}/does-not-exist" \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "F2 exit code 1 when vault missing"

# -----------------------------------------------------------------------------
# Test F3: claude コマンドが PATH にない → exit 1
# -----------------------------------------------------------------------------
# fake HOME を指すことで、スクリプト内の PATH 補完 ($HOME/.local/bin 等) も
# 実在しないディレクトリになる。このマシンの /usr/local/bin, /opt/homebrew/bin
# には claude がインストールされていないことを前提とする (事前確認済み)。
echo "test F3: claude not in PATH -> exit 1"
VAULT_F3="$(make_vault vault-f3)"
FAKE_HOME_F3="${TMPROOT}/fake-home-f3"
mkdir -p "${FAKE_HOME_F3}"
set +e
out_f3="$(
  env -i \
    HOME="${FAKE_HOME_F3}" \
    PATH="/usr/bin:/bin" \
    OBSIDIAN_VAULT="${VAULT_F3}" \
    bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "1" "${rc}" "F3 exit code 1 when claude missing"
assert_contains "${out_f3}" "claude command not found" "F3 error message present"

# -----------------------------------------------------------------------------
# Test F1: 未処理ログ 0 件 → claude 呼ばず exit 0
# -----------------------------------------------------------------------------
echo "test F1: no unprocessed logs -> skip"
VAULT_F1="$(make_vault vault-f1)"
# すでに取り込み済みのログ (ingested: true) だけ置く
cat > "${VAULT_F1}/session-logs/already-done.md" <<'EOF'
---
type: session-log
ingested: true
---
EOF
set +e
out_f1="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F1}" \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F1 exit code 0 when nothing to ingest"
assert_contains "${out_f1}" "No unprocessed logs" "F1 skip message present"
# stub claude が呼ばれていないことを確認
if printf '%s' "${out_f1}" | grep -q "stub-claude called"; then
  fail "F1 claude stub should NOT be called"
else
  pass "F1 claude stub was not called"
fi

# -----------------------------------------------------------------------------
# Test F4: 未処理ログあり + DRY RUN → claude 呼び出し経路に到達
# -----------------------------------------------------------------------------
echo "test F4: unprocessed logs present + dry run -> reaches ingest call"
VAULT_F4="$(make_vault vault-f4)"
add_unprocessed_log "${VAULT_F4}" "20260415-100000-test-a"
add_unprocessed_log "${VAULT_F4}" "20260415-100100-test-b"
# git init しておくと git pull/push が silently fail するが処理は完走する
(cd "${VAULT_F4}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)

set +e
out_f4="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F4}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F4 exit code 0"
assert_contains "${out_f4}" "Found 2 unprocessed log" "F4 counted 2 logs"
assert_contains "${out_f4}" "DRY RUN: would call claude" "F4 reached ingest call (dry run)"
assert_contains "${out_f4}" "Done." "F4 completed"

# -----------------------------------------------------------------------------
# Test F5: 非 git vault → Ingest は成功、git 操作は silent fail
# -----------------------------------------------------------------------------
echo "test F5: non-git vault -> ingest succeeds, git silently fails"
VAULT_F5="$(make_vault vault-f5)"
add_unprocessed_log "${VAULT_F5}" "20260415-110000-test-c"

set +e
out_f5="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F5}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F5 exit code 0 for non-git vault"
assert_contains "${out_f5}" "DRY RUN: would call claude" "F5 ingest path reached"
# git コマンドのエラー出力は 2>/dev/null で潰されているので目視できなくて良い

# -----------------------------------------------------------------------------
# Phase I: wiki/analyses/ 抽出指示が INGEST_PROMPT に含まれることを検証
#
# 方針:
#   claude を stub 化して、argv[2] (プロンプト本文) を一時ファイルに書き出す。
#   そのファイルを grep してプロンプト内容を検査する。
#   DRY RUN ではプロンプト本文を stdout に出さない設計なので、この方式を採る。
# -----------------------------------------------------------------------------
echo "test I1-I3: INGEST_PROMPT contains wiki/analyses/ extraction instructions"

CAPTURE_DIR="${TMPROOT}/capture"
mkdir -p "${CAPTURE_DIR}"
CAPTURE_FILE="${CAPTURE_DIR}/last-prompt.txt"

STUB_CAPTURE_DIR="${TMPROOT}/stub-capture-bin"
mkdir -p "${STUB_CAPTURE_DIR}"
cat > "${STUB_CAPTURE_DIR}/claude" <<STUB
#!/usr/bin/env bash
# Test stub: capture the -p prompt body to a file for inspection.
# argv is: -p <PROMPT> --allowedTools ... --max-turns ...
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -p)
      shift
      printf '%s' "\$1" > "${CAPTURE_FILE}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
exit 0
STUB
chmod +x "${STUB_CAPTURE_DIR}/claude"

VAULT_I="$(make_vault vault-i)"
add_unprocessed_log "${VAULT_I}" "20260415-120000-test-i"
(cd "${VAULT_I}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)

# auto-ingest.sh は PATH の先頭に $HOME/.volta/bin を追加するため、
# 素直に PATH=stub:... すると実マシンの claude に上書きされる可能性がある。
# fake HOME を使って Volta 等の実パスを存在しないディレクトリに追い出し、
# stub のみが見える状態を作る。
FAKE_HOME_I="${TMPROOT}/fake-home-i"
mkdir -p "${FAKE_HOME_I}"

set +e
out_i="$(
  env -i \
    HOME="${FAKE_HOME_I}" \
    PATH="${STUB_CAPTURE_DIR}:/usr/bin:/bin" \
    OBSIDIAN_VAULT="${VAULT_I}" \
    bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "I exit code 0"

if [[ ! -f "${CAPTURE_FILE}" ]]; then
  fail "I prompt capture file was created"
else
  pass "I prompt capture file was created"
  captured="$(cat "${CAPTURE_FILE}")"

  # I1: wiki/analyses/ への保存指示
  assert_contains "${captured}" "wiki/analyses/" "I1 prompt mentions wiki/analyses/"
  assert_contains "${captured}" "ページとして保存" "I1 prompt instructs to save as a page"

  # I2: kebab-case ファイル名 + 汎用知見優先
  assert_contains "${captured}" "kebab-case" "I2 prompt specifies kebab-case filename"
  assert_contains "${captured}" "汎用的" "I2 prompt prefers generic knowledge"

  # I3: 同名ページは更新 (重複禁止)
  assert_contains "${captured}" "既存ページを更新" "I3 prompt instructs to update existing page"
  assert_contains "${captured}" "重複" "I3 prompt forbids duplicates"
fi

# -----------------------------------------------------------------------------
# Feature 2 (PDF ingest) 関連 — F6 / F7 / F8
# -----------------------------------------------------------------------------

# auto-ingest.sh の PDF pre-step は pdfinfo + pdftotext が PATH にないと
# まるごとスキップされる。ここだけスキップではテストの意味が薄れるので、
# poppler 不在環境では F6/F7/F8 を skip する。
if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftotext >/dev/null 2>&1; then
  echo ""
  echo "SKIP F6/F7/F8: poppler (pdfinfo/pdftotext) not installed" >&2
else
  # ---------------------------------------------------------------------------
  # Test F6: raw-sources/<subdir>/<name>.pdf 配置時に extract-pdf.sh が
  #          正しい 3 引数で呼ばれる (stub で argv を記録し検証)
  # ---------------------------------------------------------------------------
  echo "test F6: PDF pre-step invokes extract-pdf.sh with correct args"
  VAULT_F6="$(make_vault vault-f6)"
  # raw-sources/papers/ を作り、ダミー PDF (サイズ 0 でも OK、stub が処理するため) を置く
  mkdir -p "${VAULT_F6}/raw-sources/papers"
  : > "${VAULT_F6}/raw-sources/papers/attention.pdf"
  # セッションログも 1 件置いて claude 呼び出しまで到達させる
  add_unprocessed_log "${VAULT_F6}" "20260417-100000-f6"

  STUB_EXTRACT_F6="${TMPROOT}/stub-extract-f6.sh"
  ARGS_FILE_F6="${TMPROOT}/extract-f6.args"
  cat > "${STUB_EXTRACT_F6}" <<STUB
#!/usr/bin/env bash
# stub: record argv to a file and exit 0
printf 'argv: %s\n' "\$*" > "${ARGS_FILE_F6}"
exit 0
STUB
  chmod +x "${STUB_EXTRACT_F6}"

  set +e
  out_f6="$(
    PATH="${STUB_DIR}:${PATH}" \
    OBSIDIAN_VAULT="${VAULT_F6}" \
    KIOKU_DRY_RUN=1 \
    KIOKU_EXTRACT_PDF_SCRIPT="${STUB_EXTRACT_F6}" \
    KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
    bash "${AUTO_INGEST}" 2>&1
  )"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "F6 exit code 0"
  assert_file_exists() {
    if [[ -f "$1" ]]; then pass "$2"; else fail "$2 (file missing: $1)"; fi
  }
  assert_file_exists "${ARGS_FILE_F6}" "F6 stub extract-pdf.sh was invoked"
  if [[ -f "${ARGS_FILE_F6}" ]]; then
    args_f6="$(cat "${ARGS_FILE_F6}")"
    assert_contains "${args_f6}" "raw-sources/papers/attention.pdf" "F6 argv contains PDF path"
    assert_contains "${args_f6}" ".cache/extracted" "F6 argv contains cache dir"
    assert_contains "${args_f6}" "papers" "F6 argv contains subdir prefix"
  fi

  # ---------------------------------------------------------------------------
  # Test F7: .cache/extracted/*.md で対応 summary 不在 → 未処理カウントに含まれる
  # ---------------------------------------------------------------------------
  echo "test F7: .cache/extracted/ MD without summary increases UNPROCESSED_SOURCES"
  VAULT_F7="$(make_vault vault-f7)"
  mkdir -p "${VAULT_F7}/.cache/extracted" "${VAULT_F7}/wiki/summaries"
  # stem = papers-attention-pp001-008 (extract-pdf.sh の命名規則)
  cat > "${VAULT_F7}/.cache/extracted/papers-attention-pp001-008.md" <<'EOF'
---
title: "Attention Is All You Need"
source_type: "papers"
page_range: "001-008"
---
dummy content
EOF

  # pre-step は本物の extract-pdf.sh が走らないよう stub に差し替え (PDF が存在しないので実質 no-op)
  set +e
  out_f7="$(
    PATH="${STUB_DIR}:${PATH}" \
    OBSIDIAN_VAULT="${VAULT_F7}" \
    KIOKU_DRY_RUN=1 \
    KIOKU_EXTRACT_PDF_SCRIPT="${STUB_EXTRACT_F6}" \
    KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
    bash "${AUTO_INGEST}" 2>&1
  )"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "F7 exit code 0"
  assert_contains "${out_f7}" "Found 0 unprocessed log(s) and 1 unprocessed raw-source" "F7 counted .cache/extracted MD"

  # ---------------------------------------------------------------------------
  # Test F8: KIOKU_INGEST_MAX_SECONDS=0 即時 timeout → PDF ループ break
  # ---------------------------------------------------------------------------
  echo "test F8: KIOKU_INGEST_MAX_SECONDS=0 aborts PDF loop before extraction"
  VAULT_F8="$(make_vault vault-f8)"
  mkdir -p "${VAULT_F8}/raw-sources/papers"
  : > "${VAULT_F8}/raw-sources/papers/deferred.pdf"
  add_unprocessed_log "${VAULT_F8}" "20260417-110000-f8"

  STUB_EXTRACT_F8="${TMPROOT}/stub-extract-f8.sh"
  INVOKED_FILE_F8="${TMPROOT}/extract-f8.invoked"
  cat > "${STUB_EXTRACT_F8}" <<STUB
#!/usr/bin/env bash
# stub: mark invocation
echo invoked > "${INVOKED_FILE_F8}"
exit 0
STUB
  chmod +x "${STUB_EXTRACT_F8}"

  set +e
  out_f8="$(
    PATH="${STUB_DIR}:${PATH}" \
    OBSIDIAN_VAULT="${VAULT_F8}" \
    KIOKU_DRY_RUN=1 \
    KIOKU_INGEST_MAX_SECONDS=0 \
    KIOKU_EXTRACT_PDF_SCRIPT="${STUB_EXTRACT_F8}" \
    KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 \
    bash "${AUTO_INGEST}" 2>&1
  )"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "F8 exit code 0"
  assert_contains "${out_f8}" "soft-timeout" "F8 soft-timeout message emitted"
  if [[ -f "${INVOKED_FILE_F8}" ]]; then
    fail "F8 stub extract-pdf.sh should NOT be invoked when timeout is 0"
  else
    pass "F8 stub extract-pdf.sh was not invoked (timeout triggered before extraction)"
  fi

  # ---------------------------------------------------------------------------
  # Test F9: VULN-004 対策 — KIOKU_EXTRACT_PDF_SCRIPT が設定されていても
  #          KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE=1 が無ければ override を拒否する
  # ---------------------------------------------------------------------------
  echo "test F9: env override rejected without KIOKU_ALLOW_EXTRACT_PDF_OVERRIDE"
  VAULT_F9="$(make_vault vault-f9)"
  mkdir -p "${VAULT_F9}/raw-sources/papers"
  : > "${VAULT_F9}/raw-sources/papers/fake.pdf"
  add_unprocessed_log "${VAULT_F9}" "20260417-130000-f9"

  STUB_EXTRACT_F9="${TMPROOT}/stub-extract-f9.sh"
  INVOKED_FILE_F9="${TMPROOT}/extract-f9.invoked"
  cat > "${STUB_EXTRACT_F9}" <<STUB
#!/usr/bin/env bash
# Evil stub: records invocation. It must NOT be called when gate is off.
echo invoked > "${INVOKED_FILE_F9}"
exit 0
STUB
  chmod +x "${STUB_EXTRACT_F9}"

  set +e
  out_f9="$(
    PATH="${STUB_DIR}:${PATH}" \
    OBSIDIAN_VAULT="${VAULT_F9}" \
    KIOKU_DRY_RUN=1 \
    KIOKU_EXTRACT_PDF_SCRIPT="${STUB_EXTRACT_F9}" \
    bash "${AUTO_INGEST}" 2>&1
  )"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "F9 exit code 0"
  assert_contains "${out_f9}" "ignoring override" "F9 override rejection WARN emitted"
  if [[ -f "${INVOKED_FILE_F9}" ]]; then
    fail "F9 evil stub extract-pdf.sh should NOT be invoked when gate is off"
  else
    pass "F9 evil stub extract-pdf.sh was not invoked (override gated)"
  fi
fi

# -----------------------------------------------------------------------------
# 機能 2.1 (MCP trigger + ハードニング) — F10 / F11 / F12
# -----------------------------------------------------------------------------
# F10: chunk MD の source_sha256 が wiki/summaries/ の sha256 と不一致 → 再 Ingest 対象
# F11: 別プロセスが .kioku-mcp.lock を保持 (TTL 内) → auto-ingest skip exit 0
# F12: 旧命名 (`<subdir>-<stem>-pp*.md`、二重ハイフンなし) の既存 chunk が壊れず動作
# -----------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Test F10: source_sha256 mismatch -> UNPROCESSED_SOURCES increases
# ---------------------------------------------------------------------------
echo "test F10: source_sha256 mismatch between chunk and summary re-ingests"
VAULT_F10="$(make_vault vault-f10)"
mkdir -p "${VAULT_F10}/.cache/extracted" "${VAULT_F10}/wiki/summaries"
# chunk MD と同名 summary を用意し、sha256 が異なるようにする。
cat > "${VAULT_F10}/.cache/extracted/papers--foo-pp001-015.md" <<'EOF'
---
title: "Foo"
source_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
page_range: "001-015"
---
chunk body
EOF
cat > "${VAULT_F10}/wiki/summaries/papers--foo-pp001-015.md" <<'EOF'
---
title: "Foo (old summary)"
source_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
---
old summary
EOF
set +e
out_f10="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F10}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_EXTRACT_PDF_SCRIPT="/nonexistent-ignored" \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F10 exit code 0"
assert_contains "${out_f10}" "Found 0 unprocessed log(s) and 1 unprocessed raw-source" "F10 mismatch counted as unprocessed"

# F10b: sha256 一致なら未処理扱いしない
VAULT_F10B="$(make_vault vault-f10b)"
mkdir -p "${VAULT_F10B}/.cache/extracted" "${VAULT_F10B}/wiki/summaries"
cat > "${VAULT_F10B}/.cache/extracted/papers--bar-pp001-010.md" <<'EOF'
---
title: "Bar"
source_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
---
chunk
EOF
cat > "${VAULT_F10B}/wiki/summaries/papers--bar-pp001-010.md" <<'EOF'
---
title: "Bar summary"
source_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
---
summary
EOF
set +e
out_f10b="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F10B}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F10b exit code 0"
assert_contains "${out_f10b}" "No unprocessed logs or raw-sources" "F10b matching sha256 not re-ingested"

# ---------------------------------------------------------------------------
# Test F11: .kioku-mcp.lock held by another process -> skip exit 0
# ---------------------------------------------------------------------------
echo "test F11: lockfile held by another writer -> skip exit 0"
VAULT_F11="$(make_vault vault-f11)"
add_unprocessed_log "${VAULT_F11}" "20260417-200000-f11"
# 別プロセスが保持中を模擬: 新鮮な lockfile を手で作る
printf '%s %s\n' "99999" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${VAULT_F11}/.kioku-mcp.lock"
set +e
out_f11="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F11}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_LOCK_ACQUIRE_TIMEOUT=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F11 exit code 0 when lock held"
assert_contains "${out_f11}" "another writer holds" "F11 lock-held message emitted"
# stub claude が呼ばれていないこと (ingest 経路に入っていない)
if printf '%s' "${out_f11}" | grep -q "DRY RUN: would call claude"; then
  fail "F11 ingest should have been skipped by lock"
else
  pass "F11 ingest path was not entered"
fi
# lockfile を別プロセスのまま残しても、auto-ingest は自分のものでないので unlink しない
if [[ -f "${VAULT_F11}/.kioku-mcp.lock" ]]; then
  pass "F11 foreign lock preserved (not unlinked by failed acquire)"
else
  fail "F11 foreign lock was unexpectedly removed"
fi

# F11b: stale lockfile (TTL 超過) は自動回収される
echo "test F11b: stale lockfile (past TTL) auto-recovered"
VAULT_F11B="$(make_vault vault-f11b)"
add_unprocessed_log "${VAULT_F11B}" "20260417-210000-f11b"
touch "${VAULT_F11B}/.kioku-mcp.lock"
# lockfile の mtime を過去にする (2 時間前)
touch -t "$(date -v-2H +%Y%m%d%H%M 2>/dev/null || date -d '-2 hours' +%Y%m%d%H%M)" \
  "${VAULT_F11B}/.kioku-mcp.lock"
(cd "${VAULT_F11B}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)
set +e
out_f11b="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F11B}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_LOCK_TTL_SECONDS=60 \
  KIOKU_LOCK_ACQUIRE_TIMEOUT=2 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F11b exit code 0 (stale lock recovered)"
assert_contains "${out_f11b}" "DRY RUN: would call claude" "F11b ingest path reached after stale lock recovery"

# ---------------------------------------------------------------------------
# Test F12: legacy single-hyphen chunk naming remains compatible
# ---------------------------------------------------------------------------
echo "test F12: legacy chunk naming (<subdir>-<stem>-pp*.md) still counted"
VAULT_F12="$(make_vault vault-f12)"
mkdir -p "${VAULT_F12}/.cache/extracted"
# Legacy chunk without source_sha256 and without matching summary → unprocessed
cat > "${VAULT_F12}/.cache/extracted/papers-legacy-pp001-008.md" <<'EOF'
---
title: "Legacy"
page_range: "001-008"
---
legacy body
EOF
set +e
out_f12="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F12}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F12 exit code 0"
assert_contains "${out_f12}" "Found 0 unprocessed log(s) and 1 unprocessed raw-source" "F12 legacy chunk counted as unprocessed"

# -----------------------------------------------------------------------------
# 機能 2.2 (HTML/URL ingest) — F13 / F14 / F15 / F16 / F17 / F18
# -----------------------------------------------------------------------------
# F13: urls.txt が 1 行 URL → extract-url.sh が argv で urls-file 指定で呼ばれる
# F14: コメント / 空行混じりの urls.txt → cron は 1 ファイル = 1 invocation で渡す
#      (実際の "1 URL のみ実行" 判定は extract-url.sh / urls-txt-parser 側のため
#      ここでは extract-url.sh が **ちょうど 1 回** 呼ばれることだけ assert する)
# F15: DSL 行 (url ; tags=foo,bar) を含む urls.txt → cron は file をそのまま渡す。
#      stub の argv に urls.txt のパスが渡ることだけ assert する (DSL parsing は downstream)
# F16: 既に fetched/<slug>.md + sha 一致 → cron は extract-url.sh を呼ぶ (skip 判定は CLI 側)
# F17: REFRESH_DAYS 経過 → CLI 側で re-fetch、cron 層では関与しないため MCP unit に委譲 (pass)
# F18: KIOKU_INGEST_MAX_SECONDS=0 → URL pre-step 即時 break、stub 未呼び出し
# -----------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Test F13: urls.txt 1 行 URL → extract-url.sh が urls-file argv 付きで呼ばれる
# ---------------------------------------------------------------------------
echo "test F13: urls.txt -> extract-url.sh invoked with --urls-file"
VAULT_F13="$(make_vault vault-f13)"
mkdir -p "${VAULT_F13}/raw-sources/articles"
cat > "${VAULT_F13}/raw-sources/articles/urls.txt" <<'EOF'
https://example.com/a
EOF
add_unprocessed_log "${VAULT_F13}" "20260419-100000-f13"

STUB_EXTRACT_URL_F13="${TMPROOT}/stub-extract-url-f13.sh"
ARGS_FILE_F13="${TMPROOT}/extract-url-f13.args"
cat > "${STUB_EXTRACT_URL_F13}" <<STUB
#!/usr/bin/env bash
printf 'argv: %s\n' "\$*" >> "${ARGS_FILE_F13}"
exit 0
STUB
chmod +x "${STUB_EXTRACT_URL_F13}"

set +e
out_f13="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F13}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_EXTRACT_URL_SCRIPT="${STUB_EXTRACT_URL_F13}" \
  KIOKU_ALLOW_EXTRACT_URL_OVERRIDE=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F13 exit 0"
if [[ -f "${ARGS_FILE_F13}" ]]; then
  pass "F13 extract-url stub invoked"
  args_f13="$(cat "${ARGS_FILE_F13}")"
  assert_contains "${args_f13}" "--urls-file" "F13 --urls-file flag passed"
  assert_contains "${args_f13}" "raw-sources/articles/urls.txt" "F13 urls.txt path passed"
  assert_contains "${args_f13}" "--vault" "F13 --vault flag passed"
  assert_contains "${args_f13}" "--subdir" "F13 --subdir flag passed"
  assert_contains "${args_f13}" "articles" "F13 subdir name (articles) passed"
else
  fail "F13 extract-url stub not invoked"
fi

# ---------------------------------------------------------------------------
# Test F14: コメント / 空行を含む urls.txt → cron は 1 file = 1 call で渡す
# (DSL parsing / コメント skip は extract-url.sh 側、urls-txt-parser.test.mjs で担保)
# ---------------------------------------------------------------------------
echo "test F14: urls.txt with comments -> 1 call to extract-url.sh (parsing is downstream)"
VAULT_F14="$(make_vault vault-f14)"
mkdir -p "${VAULT_F14}/raw-sources/articles"
cat > "${VAULT_F14}/raw-sources/articles/urls.txt" <<'EOF'
# this is a comment

https://example.com/real
# another comment
EOF
add_unprocessed_log "${VAULT_F14}" "20260419-110000-f14"

STUB_EXTRACT_URL_F14="${TMPROOT}/stub-extract-url-f14.sh"
ARGS_FILE_F14="${TMPROOT}/extract-url-f14.args"
cat > "${STUB_EXTRACT_URL_F14}" <<STUB
#!/usr/bin/env bash
printf 'argv: %s\n' "\$*" >> "${ARGS_FILE_F14}"
exit 0
STUB
chmod +x "${STUB_EXTRACT_URL_F14}"

set +e
PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F14}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_EXTRACT_URL_SCRIPT="${STUB_EXTRACT_URL_F14}" \
  KIOKU_ALLOW_EXTRACT_URL_OVERRIDE=1 \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "${rc}" "F14 exit 0"
# extract-url.sh は 1 urls.txt あたり 1 回しか呼ばれない (file 自体の comment skip は downstream)
# set +e は grep が 0 ヒット (= rc 1) のとき pipeline が trip しないように一時退避
set +e
n_calls_f14=$(grep -c "argv:" "${ARGS_FILE_F14}" 2>/dev/null)
set -e
n_calls_f14="${n_calls_f14:-0}"
assert_eq "1" "${n_calls_f14}" "F14 extract-url.sh invoked exactly 1 time per urls.txt"

# ---------------------------------------------------------------------------
# Test F15: DSL 行 (url ; tags=foo,bar) を含む urls.txt → cron は file path だけを渡す
# (DSL → --tags 変換は extract-url.sh 内、urls-txt-parser.test.mjs で担保)
# ここでは cron 層が urls.txt の path を正しく渡せることだけ assert
# ---------------------------------------------------------------------------
echo "test F15: urls.txt with DSL row -> file path passed (DSL parsing is downstream)"
VAULT_F15="$(make_vault vault-f15)"
mkdir -p "${VAULT_F15}/raw-sources/articles"
cat > "${VAULT_F15}/raw-sources/articles/urls.txt" <<'EOF'
https://example.com/tagged ; tags=foo,bar
EOF
add_unprocessed_log "${VAULT_F15}" "20260419-120000-f15"

STUB_EXTRACT_URL_F15="${TMPROOT}/stub-extract-url-f15.sh"
ARGS_FILE_F15="${TMPROOT}/extract-url-f15.args"
cat > "${STUB_EXTRACT_URL_F15}" <<STUB
#!/usr/bin/env bash
printf 'argv: %s\n' "\$*" >> "${ARGS_FILE_F15}"
exit 0
STUB
chmod +x "${STUB_EXTRACT_URL_F15}"

set +e
PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F15}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_EXTRACT_URL_SCRIPT="${STUB_EXTRACT_URL_F15}" \
  KIOKU_ALLOW_EXTRACT_URL_OVERRIDE=1 \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "${rc}" "F15 exit 0"
args_f15="$(cat "${ARGS_FILE_F15}" 2>/dev/null || echo '')"
assert_contains "${args_f15}" "raw-sources/articles/urls.txt" "F15 urls.txt path passed (DSL parsing downstream)"

# ---------------------------------------------------------------------------
# Test F16: fetched/<slug>.md が既存 + sha 一致 → cron は extract-url.sh を呼ぶ
# (re-fetch skip 判定は CLI 側; ここでは cron が呼び出すことだけ確認)
# ---------------------------------------------------------------------------
echo "test F16: existing fetched MD + sha match → extract-url.sh still invoked by cron"
VAULT_F16="$(make_vault vault-f16)"
mkdir -p "${VAULT_F16}/raw-sources/articles/fetched"
cat > "${VAULT_F16}/raw-sources/articles/fetched/example.com-done.md" <<'EOF'
---
source_url: "https://example.com/done"
source_sha256: "aaa"
fetched_at: "2026-04-19T00:00:00Z"
refresh_days: 30
---
body
EOF
cat > "${VAULT_F16}/raw-sources/articles/urls.txt" <<'EOF'
https://example.com/done
EOF
STUB_EXTRACT_URL_F16="${TMPROOT}/stub-extract-url-f16.sh"
CALL_LOG_F16="${TMPROOT}/extract-url-f16.called"
cat > "${STUB_EXTRACT_URL_F16}" <<STUB
#!/usr/bin/env bash
echo called >> "${CALL_LOG_F16}"
exit 0
STUB
chmod +x "${STUB_EXTRACT_URL_F16}"
set +e
PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F16}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_EXTRACT_URL_SCRIPT="${STUB_EXTRACT_URL_F16}" \
  KIOKU_ALLOW_EXTRACT_URL_OVERRIDE=1 \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
set -e
# cron 側では skip 判定をしないので、extract-url.sh は呼ばれる (skip 判定は CLI 内)
assert_contains "$(cat ${CALL_LOG_F16} 2>/dev/null || echo '')" "called" "F16 URL pre-step attempted (CLI handles re-fetch skip)"

# ---------------------------------------------------------------------------
# Test F17: REFRESH_DAYS 経過時の re-fetch は CLI 側担当 → MCP unit test に委譲
# ---------------------------------------------------------------------------
echo "test F17: skipped — see MCP40 in tools-ingest-url.test.mjs (CLI-level concern)"
pass "F17 see MCP unit tests"

# ---------------------------------------------------------------------------
# Test F18: KIOKU_INGEST_MAX_SECONDS=0 → URL pre-step 即 break、stub 未呼び出し
# ---------------------------------------------------------------------------
echo "test F18: KIOKU_INGEST_MAX_SECONDS=0 → URL loop breaks before stub invocation"
VAULT_F18="$(make_vault vault-f18)"
mkdir -p "${VAULT_F18}/raw-sources/articles"
cat > "${VAULT_F18}/raw-sources/articles/urls.txt" <<'EOF'
https://example.com/should-not-be-fetched
EOF
add_unprocessed_log "${VAULT_F18}" "20260419-130000-f18"

STUB_EXTRACT_URL_F18="${TMPROOT}/stub-extract-url-f18.sh"
INVOKED_F18="${TMPROOT}/extract-url-f18.invoked"
cat > "${STUB_EXTRACT_URL_F18}" <<STUB
#!/usr/bin/env bash
echo called > "${INVOKED_F18}"
exit 0
STUB
chmod +x "${STUB_EXTRACT_URL_F18}"

set +e
out_f18="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F18}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_INGEST_MAX_SECONDS=0 \
  KIOKU_EXTRACT_URL_SCRIPT="${STUB_EXTRACT_URL_F18}" \
  KIOKU_ALLOW_EXTRACT_URL_OVERRIDE=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
set -e
if [[ -f "${INVOKED_F18}" ]]; then
  fail "F18 extract-url should NOT be invoked when soft-timeout is 0"
else
  pass "F18 soft-timeout prevents URL fetch"
fi

# -----------------------------------------------------------------------------
# Test F19 (v0.4.0 Tier A#2, 2026-04-21): detached HEAD ガード
# rebase 中断・detached checkout 状態で auto-ingest が走ると、guard 無しでは
# git commit が detached HEAD 先端に積まれて push 失敗でローカル drift する。
# guard (git symbolic-ref -q HEAD) で git 書き込みを丸ごと skip + WARN することを検証。
# -----------------------------------------------------------------------------
echo "test F19: detached HEAD state -> skip git commit/push + WARN"
VAULT_F19="$(make_vault vault-f19)"
add_unprocessed_log "${VAULT_F19}" "20260421-100000-test-f19"
(
  cd "${VAULT_F19}" && \
  git init --quiet && \
  git config user.email t@test && \
  git config user.name t && \
  echo 'session-logs/' > .gitignore && \
  git add .gitignore && \
  git commit -m init --quiet && \
  git checkout --detach --quiet
)
# wiki/ に変更を用意: guard が無ければ `git diff --cached` が非空となり
# `git commit` が detached HEAD 先端に積まれてしまうシナリオを再現する。
echo "content" > "${VAULT_F19}/wiki/new-page.md"

before_sha_f19="$(cd "${VAULT_F19}" && git rev-parse HEAD)"

set +e
out_f19="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F19}" \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e

after_sha_f19="$(cd "${VAULT_F19}" && git rev-parse HEAD)"

assert_eq "0" "${rc}" "F19 exit 0 (non-destructive fail-safe)"
assert_contains "${out_f19}" "detached HEAD" "F19 stderr mentions detached HEAD"
assert_contains "${out_f19}" "Recovery:" "F19 stderr provides recovery hint"
assert_eq "${before_sha_f19}" "${after_sha_f19}" "F19 HEAD unchanged (guard prevented commit in detached state)"

# -----------------------------------------------------------------------------
# サマリ
# -----------------------------------------------------------------------------
echo
echo "==========================="
echo "  passed: ${PASS}"
echo "  failed: ${FAIL}"
echo "==========================="

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
