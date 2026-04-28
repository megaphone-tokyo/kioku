#!/usr/bin/env bash
# tests/hooks/no-network-import.test.sh — v0.7.0 Q2 network import audit (NH3)
#
# 目的: hooks/ 配下の module に http / https / net / dgram / tls / dns 等の
# ネットワーク関連組込みモジュール import が混入していないことを静的に verify。
# .claude/rules/security.md:
#   "外部ネットワーク禁止: Hook スクリプトは `http`, `https`, `net`, `dgram` を
#    import しない"
# Test prefix: NET-1

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/hooks"

fail_count=0
fail() {
  echo "FAIL: $*" >&2
  fail_count=$((fail_count + 1))
}
ok() {
  echo "OK: $*"
}

# NET-1: hooks/ 配下の全 .mjs を走査 (macOS 標準 bash 3.2 互換の find|while パターン)
file_count=0
while IFS= read -r f; do
  rel="${f#"${HOOKS_DIR}/"}"
  file_count=$((file_count + 1))
  # import { ... } from 'node:http' / 'node:https' / 'node:net' / 'node:dgram' / 'node:tls' / 'node:dns'
  if grep -E "^[[:space:]]*import[^;]+from[[:space:]]+['\"]node:(http|https|net|dgram|tls|dns)['\"]" "${f}" >/dev/null; then
    hits=$(grep -nE "^[[:space:]]*import[^;]+from[[:space:]]+['\"]node:(http|https|net|dgram|tls|dns)['\"]" "${f}")
    fail "${rel}: network module import found"
    echo "${hits}" >&2
  fi
  # bare form: import 'http' / 'https' / 'net' / 'dgram' / 'tls' / 'dns' (without node: prefix)
  if grep -E "^[[:space:]]*import[^;]+from[[:space:]]+['\"](http|https|net|dgram|tls|dns)['\"]" "${f}" >/dev/null; then
    hits=$(grep -nE "^[[:space:]]*import[^;]+from[[:space:]]+['\"](http|https|net|dgram|tls|dns)['\"]" "${f}")
    fail "${rel}: bare network module import found"
    echo "${hits}" >&2
  fi
done < <(find "${HOOKS_DIR}" -type f -name '*.mjs' | sort)

if [[ ${file_count} -eq 0 ]]; then
  fail "no .mjs files found under ${HOOKS_DIR}"
fi

if [[ ${fail_count} -gt 0 ]]; then
  echo "NET-1: FAILED (${fail_count} issue(s))" >&2
  exit 1
fi

ok "NET-1: no network-related module imports in hooks/ (${file_count} files audited)"
