#!/usr/bin/env bash
# extract-url.test.sh — scripts/extract-url.sh のスモーク
#
# 実行: bash tools/claude-brain/tests/extract-url.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EXTRACT="${REPO_ROOT}/tools/claude-brain/scripts/extract-url.sh"

unset OBSIDIAN_VAULT || true
TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok  $1"; }
fail() { FAIL=$((FAIL+1)); echo "  NG  $1" >&2; }
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"
  else fail "$3 (expected=$1, actual=$2)"; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then pass "$3"
  else fail "$3 (not found: $2)"; fi
}

# EU1: --help → exit 0 + "Usage"
echo "test EU1: --help exits 0"
set +e; out1="$(bash "${EXTRACT}" --help 2>&1)"; rc=$?; set -e
assert_eq "0" "${rc}" "EU1 --help exit 0"
assert_contains "${out1}" "Usage" "EU1 usage shown"

# EU2: missing --url and --urls-file → exit 2
echo "test EU2: missing --url exits 2"
set +e; out2="$(bash "${EXTRACT}" --vault "${TMPROOT}/v" 2>&1)"; rc=$?; set -e
assert_eq "2" "${rc}" "EU2 exit 2"
assert_contains "${out2}" "--url required" "EU2 error message"

# EU3: node missing → exit 1
# `env -i PATH=/usr/bin:/bin` to strip volta/brew installations of node.
# macOS default: /usr/bin/node does not exist, so node is unavailable.
echo "test EU3: node missing exits 1"
set +e
out3="$(env -i HOME=/tmp PATH=/usr/bin:/bin bash "${EXTRACT}" \
  --url http://example.com --vault "${TMPROOT}/v" 2>&1)"
rc=$?
set -e
if command -v /usr/bin/node >/dev/null 2>&1; then
  # node が /usr/bin/node にある稀な環境では EU3 を skip
  echo "  skip  EU3 (node exists at /usr/bin/node)"
else
  assert_eq "1" "${rc}" "EU3 exit 1"
  assert_contains "${out3}" "node" "EU3 mentions node"
fi

# EU4: --urls-file with a bad-URL line → exit 0 (warnings only)
echo "test EU4: bad URL in urls.txt is tolerated"
mkdir -p "${TMPROOT}/v"
echo "not-a-url" > "${TMPROOT}/urls.txt"
set +e; out4="$(bash "${EXTRACT}" --urls-file "${TMPROOT}/urls.txt" --vault "${TMPROOT}/v" --subdir articles 2>&1)"; rc=$?; set -e
assert_eq "0" "${rc}" "EU4 exit 0 (bad URL → warning only)"
assert_contains "${out4}" "skip non-URL" "EU4 warned on non-URL"

# EU5: --urls-file processes multiple URLs (smoke — inspecting stdout/stderr)
echo "test EU5: --urls-file reads and processes entries"
cat > "${TMPROOT}/urls-multi.txt" <<EOF
# header comment
http://example.invalid/a
http://example.invalid/b ; tags=x
EOF
set +e; out5="$(bash "${EXTRACT}" --urls-file "${TMPROOT}/urls-multi.txt" --vault "${TMPROOT}/v" --subdir articles 2>&1)"; rc=$?; set -e
assert_eq "0" "${rc}" "EU5 exit 0 (loop completes even if individual URLs fail)"
assert_contains "${out5}" "example.invalid/a" "EU5 first URL logged"
assert_contains "${out5}" "example.invalid/b" "EU5 second URL logged"

# EU6: comment-only file is a no-op
echo "test EU6: comment-only urls.txt"
cat > "${TMPROOT}/urls-comments.txt" <<EOF
# all comments
# nothing to do
EOF
set +e; out6="$(bash "${EXTRACT}" --urls-file "${TMPROOT}/urls-comments.txt" --vault "${TMPROOT}/v" --subdir articles 2>&1)"; rc=$?; set -e
assert_eq "0" "${rc}" "EU6 exit 0 with no URLs"

# EU7: unknown DSL key produces warning but does not abort
echo "test EU7: unknown DSL key"
echo "http://example.invalid/c ; weirdkey=foo" > "${TMPROOT}/urls-weird.txt"
set +e; out7="$(bash "${EXTRACT}" --urls-file "${TMPROOT}/urls-weird.txt" --vault "${TMPROOT}/v" --subdir articles 2>&1)"; rc=$?; set -e
assert_eq "0" "${rc}" "EU7 exit 0 despite unknown DSL"
assert_contains "${out7}" "unknown DSL key: weirdkey" "EU7 warned on weirdkey"

# EU8: unknown flag → exit 2
echo "test EU8: unknown flag"
set +e; out8="$(bash "${EXTRACT}" --url http://example.com --bogus yes --vault "${TMPROOT}/v" 2>&1)"; rc=$?; set -e
assert_eq "2" "${rc}" "EU8 unknown flag exit 2"
assert_contains "${out8}" "unknown flag" "EU8 error mentions flag"

echo
total=$((PASS+FAIL))
echo "extract-url.test.sh: ${PASS}/${total} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]] || exit 1
