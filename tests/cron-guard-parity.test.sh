#!/usr/bin/env bash
#
# cron-guard-parity.test.sh — cron/setup 層の env-override ガード統一性を
# invariant テストとして強制する (v0.4.0 Tier B#2)。
#
# 実行: bash tools/claude-brain/tests/cron-guard-parity.test.sh
#
# ## 背景
#
# claude-brain には 2 系統の env override / escape-hatch flag が存在する:
#
# 1. **Category A — script override gate** (v0.3.0 VULN-004 対策):
#    `KIOKU_EXTRACT_<RES>_SCRIPT` / `KIOKU_ALLOW_EXTRACT_<RES>_OVERRIDE` のペアで、
#    テスト時のみ script path を差し替えるための env。production cron では
#    _OVERRIDE ゲートが無ければ WARN + 無視する。使用場所は scripts/auto-ingest.sh のみ。
#
# 2. **Category B — cron escape hatch** (v0.3.0 LOW-d4 + v0.3.1 NEW-L2 対策):
#    `KIOKU_ALLOW_<HAZARD>_IN_CRON` で cron 経路で危険操作 (loopback / robots bypass)
#    を明示 opt-in する gate。使用場所は scripts/extract-url.sh のみ。
#
# どちらも child-env.mjs の ENV_ALLOW_EXACT allowlist に **意図的に載せない**
# (HIGH-d1 fix + NEW-L2 の設計意図)。本テストはこの設計意図が drift しないよう
# 不変条件を enforcement する。
#
# ## 検証項目
#
#   CGP-1 auto-ingest.sh の各 KIOKU_EXTRACT_<X>_SCRIPT に対応する
#         KIOKU_ALLOW_EXTRACT_<X>_OVERRIDE ignore 分岐が存在する (A pattern の対称性)
#   CGP-2 mcp/lib/child-env.mjs の ENV_ALLOW_EXACT に KIOKU_EXTRACT_* /
#         KIOKU_ALLOW_EXTRACT_* / KIOKU_URL_* / KIOKU_ALLOW_*_IN_CRON が載っていない
#   CGP-3 scripts/extract-url.sh に Category B escape hatch ガード
#         (KIOKU_ALLOW_LOOPBACK_IN_CRON / KIOKU_ALLOW_IGNORE_ROBOTS_IN_CRON) が存在
#   CGP-4 Category A pattern (KIOKU_EXTRACT_*_SCRIPT) を使うのは scripts/auto-ingest.sh
#         のみ (他 script への drift なし)
#   CGP-5 Category B pattern (KIOKU_ALLOW_*_IN_CRON) を使うのは scripts/extract-url.sh
#         のみ (他 script への drift なし)
#
# 注意: macOS 標準 bash 3.2 でも動くように `mapfile` / associative array /
# process substitution の多用を避けている。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOOL_ROOT="${REPO_ROOT}/tools/claude-brain"
SCRIPTS_DIR="${TOOL_ROOT}/scripts"
CHILD_ENV="${TOOL_ROOT}/mcp/lib/child-env.mjs"
AUTO_INGEST="${SCRIPTS_DIR}/auto-ingest.sh"
EXTRACT_URL="${SCRIPTS_DIR}/extract-url.sh"

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

# -----------------------------------------------------------------------------
# CGP-1: Category A pattern の対称性
#   各 KIOKU_EXTRACT_<X>_SCRIPT に対し、同じ <X> の KIOKU_ALLOW_EXTRACT_<X>_OVERRIDE
#   ignore 分岐 (WARN + fallback) が存在することを確認。
# -----------------------------------------------------------------------------
echo "test CGP-1: auto-ingest.sh の script override ゲート対称性"

if [[ ! -f "${AUTO_INGEST}" ]]; then
  fail "CGP-1 auto-ingest.sh not found at ${AUTO_INGEST}"
else
  # KIOKU_EXTRACT_<X>_SCRIPT を env lookup している行から <X> を抽出
  extract_resources="$(
    grep -oE 'KIOKU_EXTRACT_[A-Z]+_SCRIPT' "${AUTO_INGEST}" 2>/dev/null \
      | sed -E 's/^KIOKU_EXTRACT_([A-Z]+)_SCRIPT$/\1/' \
      | sort -u \
      | tr '\n' ' '
  )"

  if [[ -z "${extract_resources// }" ]]; then
    fail "CGP-1 no KIOKU_EXTRACT_*_SCRIPT lookup found in auto-ingest.sh (regression?)"
  else
    pass "CGP-1 found script-override resource(s): ${extract_resources}"
  fi

  # 各 <X> に対し、対応する _SCRIPT lookup / _OVERRIDE gate / WARN が存在するか
  for res in ${extract_resources}; do
    script_re="\\\$\\{KIOKU_EXTRACT_${res}_SCRIPT:-"
    override_re="\\\$\\{KIOKU_ALLOW_EXTRACT_${res}_OVERRIDE:-0\\}"
    warn_str="KIOKU_EXTRACT_${res}_SCRIPT is set but KIOKU_ALLOW_EXTRACT_${res}_OVERRIDE"

    if grep -qE "${script_re}" "${AUTO_INGEST}"; then
      pass "CGP-1[${res}] script env lookup present"
    else
      fail "CGP-1[${res}] script env lookup \${KIOKU_EXTRACT_${res}_SCRIPT:-...} not found"
    fi

    if grep -qE "${override_re}" "${AUTO_INGEST}"; then
      pass "CGP-1[${res}] override gate present"
    else
      fail "CGP-1[${res}] gate \${KIOKU_ALLOW_EXTRACT_${res}_OVERRIDE:-0} not found"
    fi

    if grep -qF "${warn_str}" "${AUTO_INGEST}"; then
      pass "CGP-1[${res}] WARN message present"
    else
      fail "CGP-1[${res}] WARN message naming both flags not found"
    fi
  done

  # 逆方向: KIOKU_ALLOW_EXTRACT_<X>_OVERRIDE に対応する _SCRIPT も必須
  override_resources="$(
    grep -oE 'KIOKU_ALLOW_EXTRACT_[A-Z]+_OVERRIDE' "${AUTO_INGEST}" 2>/dev/null \
      | sed -E 's/^KIOKU_ALLOW_EXTRACT_([A-Z]+)_OVERRIDE$/\1/' \
      | sort -u \
      | tr '\n' ' '
  )"
  for res in ${override_resources}; do
    # extract_resources の中に含まれるか (空白区切りで包含チェック)
    if printf ' %s ' "${extract_resources}" | grep -qF " ${res} "; then
      pass "CGP-1[${res}] _OVERRIDE has matching _SCRIPT (inverse check)"
    else
      fail "CGP-1[${res}] _OVERRIDE gate found but matching _SCRIPT lookup missing"
    fi
  done
fi

# -----------------------------------------------------------------------------
# CGP-2: child-env.mjs ENV_ALLOW_EXACT に上記 flag が載っていない (HIGH-d1 不変)
# -----------------------------------------------------------------------------
echo "test CGP-2: child-env.mjs ENV_ALLOW_EXACT に禁止 prefix が含まれない"

if [[ ! -f "${CHILD_ENV}" ]]; then
  fail "CGP-2 child-env.mjs not found at ${CHILD_ENV}"
else
  # ENV_ALLOW_EXACT = new Set([ ... ]) の中身を awk で抽出
  exact_block="$(awk '/ENV_ALLOW_EXACT = new Set\(\[/,/\]\);/' "${CHILD_ENV}")"
  if [[ -z "${exact_block}" ]]; then
    fail "CGP-2 ENV_ALLOW_EXACT literal block not found"
  else
    any_leak=0
    # Category A prefixes (leaked = regression)
    for prefix in 'KIOKU_EXTRACT_' 'KIOKU_ALLOW_EXTRACT_' 'KIOKU_URL_'; do
      if printf '%s' "${exact_block}" | grep -qE "['\"]${prefix}[A-Z_]+['\"]"; then
        fail "CGP-2 forbidden prefix '${prefix}*' leaked into ENV_ALLOW_EXACT"
        any_leak=1
      fi
    done
    # Category B exact names (leaked = regression)
    for exact_name in 'KIOKU_ALLOW_LOOPBACK_IN_CRON' 'KIOKU_ALLOW_IGNORE_ROBOTS_IN_CRON'; do
      if printf '%s' "${exact_block}" | grep -qE "['\"]${exact_name}['\"]"; then
        fail "CGP-2 forbidden name '${exact_name}' leaked into ENV_ALLOW_EXACT"
        any_leak=1
      fi
    done
    if [[ "${any_leak}" -eq 0 ]]; then
      pass "CGP-2 ENV_ALLOW_EXACT excludes all forbidden patterns (Categories A + B)"
    fi
  fi

  # ENV_ALLOW_PREFIXES に KIOKU_ 丸ごとが入っていないか (旧 HIGH-d1 regression 防止)
  # コメント内の prose 記述に誤マッチしないよう、`export const` 行に限定する。
  prefixes_line="$(grep -E '^export const ENV_ALLOW_PREFIXES' "${CHILD_ENV}" || true)"
  if [[ -z "${prefixes_line}" ]]; then
    fail "CGP-2 ENV_ALLOW_PREFIXES export declaration not found"
  elif printf '%s' "${prefixes_line}" | grep -qE "['\"]KIOKU_['\"]"; then
    fail "CGP-2 ENV_ALLOW_PREFIXES contains bare 'KIOKU_' (HIGH-d1 regression)"
  else
    pass "CGP-2 ENV_ALLOW_PREFIXES excludes bare 'KIOKU_'"
  fi
fi

# -----------------------------------------------------------------------------
# CGP-3: extract-url.sh の Category B escape hatch ガード
# -----------------------------------------------------------------------------
echo "test CGP-3: extract-url.sh の cron escape-hatch ガード"

if [[ ! -f "${EXTRACT_URL}" ]]; then
  fail "CGP-3 extract-url.sh not found at ${EXTRACT_URL}"
else
  # Category B の 2 ペア: "gate:unset_target"
  for pair in \
      'KIOKU_ALLOW_LOOPBACK_IN_CRON:KIOKU_URL_ALLOW_LOOPBACK' \
      'KIOKU_ALLOW_IGNORE_ROBOTS_IN_CRON:KIOKU_URL_IGNORE_ROBOTS'; do
    gate="${pair%%:*}"
    target="${pair##*:}"
    if grep -qE "\\\$\\{${gate}:-0\\}" "${EXTRACT_URL}"; then
      pass "CGP-3[${gate}] opt-in gate present"
    else
      fail "CGP-3[${gate}] opt-in gate not found"
    fi
    if grep -qE "unset ${target}" "${EXTRACT_URL}"; then
      pass "CGP-3[${gate}] unset ${target} line present"
    else
      fail "CGP-3[${gate}] 'unset ${target}' line not found"
    fi
  done
fi

# -----------------------------------------------------------------------------
# CGP-4: Category A pattern (KIOKU_EXTRACT_*_SCRIPT) の使用は auto-ingest.sh に限定
# -----------------------------------------------------------------------------
echo "test CGP-4: Category A pattern の使用範囲"

set +e
cat_a_users="$(grep -lE 'KIOKU_EXTRACT_[A-Z]+_SCRIPT' "${SCRIPTS_DIR}"/*.sh 2>/dev/null | sort -u | tr '\n' ' ')"
set -e

if [[ -z "${cat_a_users// }" ]]; then
  fail "CGP-4 no Category A user found (regression?)"
else
  # 期待: auto-ingest.sh の 1 ファイルのみ (末尾に半角スペース付きで比較)
  if [[ "${cat_a_users}" == "${AUTO_INGEST} " ]]; then
    pass "CGP-4 Category A usage limited to scripts/auto-ingest.sh"
  else
    fail "CGP-4 Category A pattern leaked: ${cat_a_users}"
  fi
fi

# -----------------------------------------------------------------------------
# CGP-5: Category B pattern (KIOKU_ALLOW_*_IN_CRON) の使用は extract-url.sh に限定
# -----------------------------------------------------------------------------
echo "test CGP-5: Category B pattern の使用範囲"

set +e
cat_b_users="$(grep -lE 'KIOKU_ALLOW_[A-Z_]+_IN_CRON' "${SCRIPTS_DIR}"/*.sh 2>/dev/null | sort -u | tr '\n' ' ')"
set -e

if [[ -z "${cat_b_users// }" ]]; then
  fail "CGP-5 no Category B user found (regression?)"
else
  if [[ "${cat_b_users}" == "${EXTRACT_URL} " ]]; then
    pass "CGP-5 Category B usage limited to scripts/extract-url.sh"
  else
    fail "CGP-5 Category B pattern leaked: ${cat_b_users}"
  fi
fi

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
