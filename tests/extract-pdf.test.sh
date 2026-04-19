#!/usr/bin/env bash
#
# extract-pdf.test.sh — scripts/extract-pdf.sh の結合テスト。
#
# 実行: bash tools/claude-brain/tests/extract-pdf.test.sh
#
# 前提:
#   - poppler (pdfinfo / pdftotext) がインストールされている
#     macOS: brew install poppler  /  Debian: apt install poppler-utils
#   - tests/fixtures/pdf/*.pdf が commit 済み
#
# 検証項目 (設計書 26041705 §8.1):
#   EP1  8p PDF → 分割されず 1 ファイル (pp001-008.md)
#   EP2  42p PDF → 3 chunks (pp001-015 / pp015-030 / pp030-042) + overlap 検証
#   EP3  暗号化 PDF → exit 2 + ERROR ログ
#   EP4  スキャン画像 PDF → exit 3 + WARN ログ
#   EP5  本文に AWS_ACCESS_KEY_ID が含まれる PDF → 出力でマスクされている
#   EP6  pdfinfo Title が "Microsoft Word - *" → 破棄してファイル名ベース title
#   EP7  サイドカー .meta.yaml で Title を上書き
#   EP8  冪等性 — PDF より新しい chunk MD があればスキップ
#   EP9  soft limit 超過 → 先頭 N ページのみ + truncated: true
#   EP10 hard limit 超過 → exit 4 + 完全スキップ
#   EP11 サイドカー extract_layout: true → frontmatter extractor が -layout 付き
#   EP12 source_type sanitize — シェルメタ文字が除去される
#   EP16 (機能 2.1) sha256: chunk MD frontmatter に source_sha256 (64hex) が書かれる
#   EP17 (機能 2.1) 新命名: chunk MD は `<subdir>--<stem>-pp*.md` (二重ハイフン)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EXTRACT="${REPO_ROOT}/tools/claude-brain/scripts/extract-pdf.sh"
FIXTURES="${SCRIPT_DIR}/fixtures/pdf"

# 実行環境の OBSIDIAN_VAULT を切り離し、各テストケースで必要に応じて設定する。
# ユーザーシェルの実 Vault を参照して realpath prefix match が失敗するのを防ぐ。
unset OBSIDIAN_VAULT

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
assert_file_exists() {
  if [[ -f "$1" ]]; then
    pass "$2"
  else
    fail "$2 (file missing: $1)"
  fi
}
assert_not_contains() {
  if ! printf '%s' "$1" | grep -q -F -- "$2"; then
    pass "$3"
  else
    fail "$3 (unexpected substring found: $2)"
  fi
}

# 前提チェック: poppler がないとほぼ全テストが意味をなさないので早期 skip
if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftotext >/dev/null 2>&1; then
  echo "SKIP: poppler (pdfinfo/pdftotext) not installed; skipping extract-pdf tests" >&2
  exit 0
fi

make_case() {
  local name="$1"
  local subdir="$2"
  local dir="${TMPROOT}/${name}"
  mkdir -p "${dir}/raw-sources/${subdir}" "${dir}/.cache/extracted"
  printf '%s' "${dir}"
}

# -----------------------------------------------------------------------------
# EP1: 8p PDF → 1 file (non-split)
# -----------------------------------------------------------------------------
echo "test EP1: 8p PDF -> non-split single chunk"
CASE1="$(make_case ep1 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE1}/raw-sources/papers/attention.pdf"
set +e
out1="$(bash "${EXTRACT}" \
  "${CASE1}/raw-sources/papers/attention.pdf" \
  "${CASE1}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "EP1 exit 0"
assert_file_exists "${CASE1}/.cache/extracted/papers--attention-pp001-008.md" "EP1 non-split output file created"
# 2 chunk ファイルができていないことを確認
if ls "${CASE1}/.cache/extracted/"*pp009* 2>/dev/null | grep -q .; then
  fail "EP1 unexpected additional chunk present"
else
  pass "EP1 no additional chunk"
fi
content1="$(cat "${CASE1}/.cache/extracted/papers--attention-pp001-008.md")"
assert_contains "${content1}" 'source_type: "papers"' "EP1 frontmatter has source_type"
assert_contains "${content1}" "Attention page 1" "EP1 body contains page 1 text"
assert_contains "${content1}" "Attention page 8" "EP1 body contains page 8 text"

# -----------------------------------------------------------------------------
# EP2: 42p PDF -> 3 chunks with overlap at pp 15 and 30
# -----------------------------------------------------------------------------
echo "test EP2: 42p PDF -> 3 chunks with 1p overlap"
CASE2="$(make_case ep2 books)"
cp "${FIXTURES}/sample-42p.pdf" "${CASE2}/raw-sources/books/chunked.pdf"
bash "${EXTRACT}" \
  "${CASE2}/raw-sources/books/chunked.pdf" \
  "${CASE2}/.cache/extracted" \
  "books" >/dev/null 2>&1
assert_file_exists "${CASE2}/.cache/extracted/books--chunked-pp001-015.md" "EP2 chunk 1 created"
assert_file_exists "${CASE2}/.cache/extracted/books--chunked-pp015-030.md" "EP2 chunk 2 created"
assert_file_exists "${CASE2}/.cache/extracted/books--chunked-pp030-042.md" "EP2 chunk 3 created"
c1="$(cat "${CASE2}/.cache/extracted/books--chunked-pp001-015.md")"
c2="$(cat "${CASE2}/.cache/extracted/books--chunked-pp015-030.md")"
c3="$(cat "${CASE2}/.cache/extracted/books--chunked-pp030-042.md")"
assert_contains "${c1}" "Chunked page 15" "EP2 chunk 1 ends at page 15"
assert_contains "${c2}" "Chunked page 15" "EP2 chunk 2 starts at page 15 (overlap)"
assert_contains "${c2}" "Chunked page 30" "EP2 chunk 2 ends at page 30"
assert_contains "${c3}" "Chunked page 30" "EP2 chunk 3 starts at page 30 (overlap)"
assert_contains "${c3}" "Chunked page 42" "EP2 chunk 3 ends at page 42"

# -----------------------------------------------------------------------------
# EP3: encrypted PDF -> exit 2 + ERROR
# -----------------------------------------------------------------------------
echo "test EP3: encrypted PDF -> exit 2"
CASE3="$(make_case ep3 papers)"
cp "${FIXTURES}/sample-encrypted.pdf" "${CASE3}/raw-sources/papers/locked.pdf"
set +e
out3="$(bash "${EXTRACT}" \
  "${CASE3}/raw-sources/papers/locked.pdf" \
  "${CASE3}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "2" "${rc}" "EP3 encrypted PDF exit 2"
assert_contains "${out3}" "Encrypted PDF" "EP3 error message mentions Encrypted"

# -----------------------------------------------------------------------------
# EP4: scanned (image-only) PDF -> exit 3 + WARN
# -----------------------------------------------------------------------------
echo "test EP4: scanned PDF -> exit 3 (empty text)"
CASE4="$(make_case ep4 papers)"
cp "${FIXTURES}/sample-scanned.pdf" "${CASE4}/raw-sources/papers/scanned.pdf"
set +e
out4="$(bash "${EXTRACT}" \
  "${CASE4}/raw-sources/papers/scanned.pdf" \
  "${CASE4}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "3" "${rc}" "EP4 scanned PDF exit 3"
assert_contains "${out4}" "empty" "EP4 warning about empty text"
# VULN-007 (P4) 対策: exit 3 時は中途 chunk MD を削除する
if ls "${CASE4}/.cache/extracted/"*.md 2>/dev/null | grep -q .; then
  fail "EP4 empty chunk MDs should be removed, but found files"
else
  pass "EP4 empty chunk MDs removed"
fi

# -----------------------------------------------------------------------------
# EP5: PDF with AWS_ACCESS_KEY_ID text -> masked in output
# -----------------------------------------------------------------------------
echo "test EP5: PDF with secret text -> masked in output"
CASE5="$(make_case ep5 articles)"
cp "${FIXTURES}/sample-with-secret.pdf" "${CASE5}/raw-sources/articles/secret.pdf"
bash "${EXTRACT}" \
  "${CASE5}/raw-sources/articles/secret.pdf" \
  "${CASE5}/.cache/extracted" \
  "articles" >/dev/null 2>&1
out5="$(cat "${CASE5}/.cache/extracted/"*.md)"
assert_contains "${out5}" "AKIA***" "EP5 AKIA key masked"
assert_not_contains "${out5}" "AKIAFAKEEXAMPLE" "EP5 raw AKIA... not leaked"

# -----------------------------------------------------------------------------
# EP6: pdfinfo Title = "Microsoft Word - ..." -> filename fallback
# -----------------------------------------------------------------------------
echo "test EP6: pdfinfo Title 'Microsoft Word - *' -> filename fallback"
CASE6="$(make_case ep6 articles)"
cp "${FIXTURES}/sample-msword-title.pdf" "${CASE6}/raw-sources/articles/report.pdf"
bash "${EXTRACT}" \
  "${CASE6}/raw-sources/articles/report.pdf" \
  "${CASE6}/.cache/extracted" \
  "articles" >/dev/null 2>&1
out6="$(cat "${CASE6}/.cache/extracted/"*.md)"
assert_contains "${out6}" 'title: "report"' "EP6 falls back to filename stem"
assert_not_contains "${out6}" 'title: "Microsoft Word' "EP6 junk title discarded"

# -----------------------------------------------------------------------------
# EP7: sidecar .meta.yaml overrides title
# -----------------------------------------------------------------------------
echo "test EP7: sidecar .meta.yaml overrides title"
CASE7="$(make_case ep7 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE7}/raw-sources/papers/paper.pdf"
cat > "${CASE7}/raw-sources/papers/paper.meta.yaml" <<'YAML'
source_type: paper
title: Explicit Override Title
year: 2024
url: https://example.com/paper
YAML
bash "${EXTRACT}" \
  "${CASE7}/raw-sources/papers/paper.pdf" \
  "${CASE7}/.cache/extracted" \
  "papers" >/dev/null 2>&1
out7="$(cat "${CASE7}/.cache/extracted/"*.md)"
assert_contains "${out7}" 'title: "Explicit Override Title"' "EP7 sidecar title overrides pdfinfo"
assert_contains "${out7}" 'source_type: "paper"' "EP7 sidecar source_type applied"
assert_contains "${out7}" 'url: "https://example.com/paper"' "EP7 sidecar url included"

# -----------------------------------------------------------------------------
# EP8: idempotency — second run skips when chunk MDs are newer
# -----------------------------------------------------------------------------
echo "test EP8: idempotency — second run is a no-op"
CASE8="$(make_case ep8 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE8}/raw-sources/papers/idem.pdf"
bash "${EXTRACT}" \
  "${CASE8}/raw-sources/papers/idem.pdf" \
  "${CASE8}/.cache/extracted" \
  "papers" >/dev/null 2>&1
# Make chunk MDs newer than PDF
sleep 1
touch "${CASE8}/.cache/extracted/"*.md
set +e
out8="$(bash "${EXTRACT}" \
  "${CASE8}/raw-sources/papers/idem.pdf" \
  "${CASE8}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "EP8 second run exits 0"
assert_contains "${out8}" "Skip" "EP8 second run reports skip"

# -----------------------------------------------------------------------------
# EP9: soft limit exceeded -> first N pages only + truncated: true
# -----------------------------------------------------------------------------
echo "test EP9: soft limit exceeded -> truncated frontmatter"
CASE9="$(make_case ep9 books)"
cp "${FIXTURES}/sample-15p.pdf" "${CASE9}/raw-sources/books/big.pdf"
# 15p PDF against soft=10, hard=20. Effective pages = 10.
set +e
out9="$(KIOKU_PDF_MAX_SOFT_PAGES=10 KIOKU_PDF_MAX_HARD_PAGES=20 \
  bash "${EXTRACT}" \
  "${CASE9}/raw-sources/books/big.pdf" \
  "${CASE9}/.cache/extracted" \
  "books" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "EP9 truncate mode exit 0"
out9f="$(cat "${CASE9}/.cache/extracted/"*.md | head -30)"
assert_contains "${out9f}" "truncated: true" "EP9 truncated flag set"
assert_contains "${out9f}" "total_pages: 15" "EP9 total_pages retained"
assert_contains "${out9f}" "effective_pages: 10" "EP9 effective_pages reduced"

# -----------------------------------------------------------------------------
# EP10: hard limit exceeded -> exit 4
# -----------------------------------------------------------------------------
echo "test EP10: hard limit exceeded -> exit 4"
CASE10="$(make_case ep10 books)"
cp "${FIXTURES}/sample-15p.pdf" "${CASE10}/raw-sources/books/huge.pdf"
set +e
out10="$(KIOKU_PDF_MAX_HARD_PAGES=10 \
  bash "${EXTRACT}" \
  "${CASE10}/raw-sources/books/huge.pdf" \
  "${CASE10}/.cache/extracted" \
  "books" 2>&1)"
rc=$?
set -e
assert_eq "4" "${rc}" "EP10 hard limit exit 4"
assert_contains "${out10}" "hard limit" "EP10 error message mentions hard limit"

# -----------------------------------------------------------------------------
# EP11: sidecar extract_layout: true -> frontmatter indicates -layout
# -----------------------------------------------------------------------------
echo "test EP11: sidecar extract_layout: true -> -layout passed"
CASE11="$(make_case ep11 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE11}/raw-sources/papers/layout.pdf"
cat > "${CASE11}/raw-sources/papers/layout.meta.yaml" <<'YAML'
extract_layout: true
YAML
bash "${EXTRACT}" \
  "${CASE11}/raw-sources/papers/layout.pdf" \
  "${CASE11}/.cache/extracted" \
  "papers" >/dev/null 2>&1
out11="$(cat "${CASE11}/.cache/extracted/"*.md)"
assert_contains "${out11}" 'extractor: "pdftotext -layout"' "EP11 extractor reports -layout"

# -----------------------------------------------------------------------------
# EP12: source_type sanitize — shell metachars are stripped
# -----------------------------------------------------------------------------
echo "test EP12: source_type sanitize strips shell metachars"
CASE12="$(make_case ep12 articles)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE12}/raw-sources/articles/safe.pdf"
# Quoted string so YAML parses cleanly; sanitize must strip the `; `$`, etc.
cat > "${CASE12}/raw-sources/articles/safe.meta.yaml" <<'YAML'
source_type: "rm -rf &; backtick: `pwd` $HOME"
YAML
bash "${EXTRACT}" \
  "${CASE12}/raw-sources/articles/safe.pdf" \
  "${CASE12}/.cache/extracted" \
  "articles" >/dev/null 2>&1
out12="$(cat "${CASE12}/.cache/extracted/"*.md)"
assert_not_contains "${out12}" 'source_type: "rm -rf &;' "EP12 backtick/\$/;/& removed"
assert_contains "${out12}" 'source_type: "rm -rf  backtick: pwd HOME"' "EP12 sanitized source_type applied"

# -----------------------------------------------------------------------------
# EP13 (bonus): PDF outside raw-sources/ -> exit 5 (path traversal defense)
# -----------------------------------------------------------------------------
echo "test EP13: PDF outside raw-sources/ -> exit 5"
CASE13="${TMPROOT}/ep13-outside"
mkdir -p "${CASE13}/not-raw-sources" "${CASE13}/out"
cp "${FIXTURES}/sample-8p.pdf" "${CASE13}/not-raw-sources/outside.pdf"
set +e
out13="$(bash "${EXTRACT}" \
  "${CASE13}/not-raw-sources/outside.pdf" \
  "${CASE13}/out" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "5" "${rc}" "EP13 outside raw-sources/ exit 5"
assert_contains "${out13}" "not under raw-sources" "EP13 error message about raw-sources boundary"

# -----------------------------------------------------------------------------
# EP14: OBSIDIAN_VAULT が設定されているとき、偽 raw-sources (Vault 外) を reject
# VULN-011 の回帰テスト — substring `*/raw-sources/*` だけだと通ってしまう
# `/tmp/attacker/raw-sources/evil.pdf` スタイルの経路を prefix match で弾く。
# -----------------------------------------------------------------------------
echo "test EP14: fake raw-sources outside \$OBSIDIAN_VAULT -> exit 5"
CASE14_VAULT="${TMPROOT}/ep14-vault"
CASE14_FAKE="${TMPROOT}/ep14-fake/raw-sources/papers"
mkdir -p "${CASE14_VAULT}/raw-sources/papers" "${CASE14_VAULT}/.cache/extracted" "${CASE14_FAKE}"
cp "${FIXTURES}/sample-8p.pdf" "${CASE14_FAKE}/evil.pdf"
set +e
out14="$(OBSIDIAN_VAULT="${CASE14_VAULT}" bash "${EXTRACT}" \
  "${CASE14_FAKE}/evil.pdf" \
  "${CASE14_VAULT}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "5" "${rc}" "EP14 fake raw-sources outside vault exits 5"
assert_contains "${out14}" "OBSIDIAN_VAULT" "EP14 error message references OBSIDIAN_VAULT"

# -----------------------------------------------------------------------------
# EP15: OBSIDIAN_VAULT が設定されているとき、Vault 内の raw-sources/ は許可される
# -----------------------------------------------------------------------------
echo "test EP15: real \$OBSIDIAN_VAULT/raw-sources/ path accepted"
cp "${FIXTURES}/sample-8p.pdf" "${CASE14_VAULT}/raw-sources/papers/legit.pdf"
set +e
out15="$(OBSIDIAN_VAULT="${CASE14_VAULT}" bash "${EXTRACT}" \
  "${CASE14_VAULT}/raw-sources/papers/legit.pdf" \
  "${CASE14_VAULT}/.cache/extracted" \
  "papers" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "EP15 legit path under vault accepted"
assert_file_exists "${CASE14_VAULT}/.cache/extracted/papers--legit-pp001-008.md" "EP15 chunk written"

# -----------------------------------------------------------------------------
# EP16 (機能 2.1): sha256 frontmatter 検証 — chunk MD に source_sha256 (64hex) が書かれる
#                  + 同じ PDF を再実行したとき sha256 が一致 (冪等性)
# -----------------------------------------------------------------------------
echo "test EP16: source_sha256 in chunk MD frontmatter (64 hex)"
CASE16="$(make_case ep16 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE16}/raw-sources/papers/hashme.pdf"
bash "${EXTRACT}" \
  "${CASE16}/raw-sources/papers/hashme.pdf" \
  "${CASE16}/.cache/extracted" \
  "papers" >/dev/null 2>&1
chunk16="${CASE16}/.cache/extracted/papers--hashme-pp001-008.md"
assert_file_exists "${chunk16}" "EP16 chunk created"
head16="$(head -25 "${chunk16}")"
# 64 hex の source_sha256 行を正規表現で確認
if printf '%s' "${head16}" | grep -Eq '^source_sha256: "[0-9a-f]{64}"$'; then
  pass "EP16 frontmatter has source_sha256: <64hex>"
else
  fail "EP16 source_sha256 line missing or malformed"
fi

# 再実行時、手動で計算した sha256 と同一か (冪等)
if command -v shasum >/dev/null 2>&1; then
  expected_sha="$(shasum -a 256 "${CASE16}/raw-sources/papers/hashme.pdf" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  expected_sha="$(sha256sum "${CASE16}/raw-sources/papers/hashme.pdf" | awk '{print $1}')"
else
  expected_sha=""
fi
if [[ -n "${expected_sha}" ]]; then
  actual_sha="$(awk -F'"' '/^source_sha256:/ {print $2; exit}' "${chunk16}")"
  assert_eq "${expected_sha}" "${actual_sha}" "EP16 source_sha256 matches shasum computed value"
fi

# -----------------------------------------------------------------------------
# EP17 (機能 2.1): 新命名検証 — chunk MD は `<subdir>--<stem>-pp*.md` (二重ハイフン)
# -----------------------------------------------------------------------------
echo "test EP17: chunk filename uses double-hyphen between subdir and stem"
CASE17="$(make_case ep17 papers)"
cp "${FIXTURES}/sample-8p.pdf" "${CASE17}/raw-sources/papers/a-b.pdf"
bash "${EXTRACT}" \
  "${CASE17}/raw-sources/papers/a-b.pdf" \
  "${CASE17}/.cache/extracted" \
  "papers" >/dev/null 2>&1
assert_file_exists "${CASE17}/.cache/extracted/papers--a-b-pp001-008.md" "EP17 new naming (papers--a-b-pp*.md)"
# 旧命名 (papers-a-b-pp*.md、subdir と stem の間がシングルハイフン) は生成されていない
if ls "${CASE17}/.cache/extracted/papers-a-b-pp"*.md 2>/dev/null | grep -v -- '--' | grep -q .; then
  fail "EP17 legacy single-hyphen naming still emitted"
else
  pass "EP17 no legacy single-hyphen chunk filenames"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
echo ""
echo "extract-pdf.test.sh: ${PASS}/${TOTAL} passed, ${FAIL} failed"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
