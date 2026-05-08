---
name: kioku-delegation-handoff
description: "PM session が他 Claude / codex CLI session に task を委譲する handoff doc を `tools/claude-brain/handoff/YYMMDDNN_<topic>-delegation.md` として生成する skill。N=6 cycle (PR #70/#74/#84/#89/#90/#96) で組織知化された delegation pattern を再利用、LEARN#12 Rule 1 (branch+PR mandatory) + LEARN#10 双方向 precheck + LEARN#5/#6 test requirements + 完了報告 N 点セット を boilerplate として組み込み、scope-specific spec のみ user 入力で済む。`/kioku-delegation-handoff <scope-topic>` で起動、optional `--to=制作|codex|マーケ` で受け手 session type を指定。"
---

# kioku-delegation-handoff

PM session が他 Claude session (制作 Claude / codex CLI / マーケ Claude) に impl / strategic / marketing task を委譲する handoff doc 作成 を skill 化。N=6 delegation cycles で固化した template + LEARN convention を 1 commands で展開、scope-specific 部分のみ手動入力で済ませる。

## いつ使うか

- **制作 Claude session に impl task を委譲**したい時 (bugfix / new feature / refactor / test infra 等)
- **codex CLI session に strategic doc / 探索系 task を委譲**したい時 (roadmap 執筆 / 競合分析 / scope 検討)
- **マーケ Claude session に article / publish task を委譲**したい時 (release narrative / SNS post / community comm)

**使わない場面**:

- PM session 直接 impl が経済的な scope (LEARN#7 「小 task < 4h、1-2 file」zone) → handoff overhead が impl より大きく ROI 逆転
- 既に main に存在する task (LEARN#10 逆方向: 必ず `git log -10 origin/main --oneline` で先 verify)
- main hygiene 違反 state (LEARN#12 Rule 2: `git log --oneline origin/main..main` が non-empty) → 先に local commit を retroactive PR 化

## 前提 (handoff 作成前 mandatory)

- **LEARN#12 Rule 2 main hygiene clean**: `git log --oneline origin/main..main` が empty
- **LEARN#10 逆方向 precheck pass**: 委譲予定 task が main に既存しないことを `git log -10 origin/main --oneline` で verify
- **target session type が確定**: 制作 Claude / codex / マーケ のどれか
- **PM 側 LEARN#10 precheck 完了**: 委譲する spec の対象 file / function / line が現コードで verify 済 (handoff 内の "PM 側 LEARN#10 precheck 結果" table に記載するため)

## 起動

```
/kioku-delegation-handoff <scope-topic>           # default --to=制作 Claude
/kioku-delegation-handoff <scope-topic> --to=制作
/kioku-delegation-handoff <scope-topic> --to=codex
/kioku-delegation-handoff <scope-topic> --to=マーケ
```

例:
```
/kioku-delegation-handoff v0-7-3-readme-mode-based-setup
/kioku-delegation-handoff v0-8-phase-d-visualizer-pivot-decision --to=codex
/kioku-delegation-handoff v0-7-2-marketing-articles --to=マーケ
```

## 出力 path

```
tools/claude-brain/handoff/YYMMDDNN_<scope-topic>-delegation.md
  YY: 年下 2 桁 (例: 26)
  MM: 月 2 桁
  DD: 日 2 桁
  NN: 同日 N 件目の連番 (01, 02, ...)
```

例: `26050702_v0-7-3-readme-mode-based-setup-delegation.md` (= 2026-05-07 の 2 件目)

## handoff doc 構造 (auto-generated boilerplate)

以下の section を template として展開、`{{scope-specific}}` placeholder は user 入力で埋める:

```markdown
---
title: {{scope-topic}} — {{target-session-type}} session 委譲 handoff
date: YYYY-MM-DD
author: PM Claude (RYU 委譲指示、{{strategic-origin-doc}} を origin とする場合)
to: {{target-session-type}} session
status: pending
related:
  - {{strategic-origin-doc-path}} (例: plan/codex/260430_kioku-product-improvement-roadmap.md §P0)
  - {{prior-delegation-handoffs}} (例: 直前 PR #84 の handoff、N=3)
  - .claude/rules/workflow.md LEARN#5/#6/#10/#11/#12 (workflow 規約)
---

# Context

## 2-session origin (or 3-session for codex strategic → PM tactical → executor)

{{何が origin で、なぜ本 task を委譲するか}}

## 当該 release / feature との関係

{{v0.X.Y release との関係、Sprint N との関係 等}}

## LEARN#12 codification N={{N}}

- N=1: §33-38 (PR #70、4/28)、5 件 hardening
- N=2: §41 (PR #74、4/30)、frontmatter agent field
- N=3: doctor MVP (PR #84、4/30)、Sprint 1 1 番目
- N=4: drift test (PR #89、5/7)、Sprint 1 2 番目
- N=5: URL test 安定化 (PR #90、5/7)、Sprint 1 3 番目
- N=6: README mode-based (PR #96、5/7)、Sprint 1 完走 marker
- **N={{N}}: 本 PR ({{scope-topic}})** ← 今ここ

---

# PM 側 LEARN#10 precheck 結果 (YYYY-MM-DD、verified)

PM session で current state を grep verify。**全 N 確認項目 pass**:

| # | 確認項目 | 結果 |
|---|---|---|
| 1 | {{strategic spec}} が存在 | ✅ verified |
| 2 | LEARN#10 逆方向: 関連 commit が main に存在しないか | ✅ `git log -10 origin/main \| grep -iE "{{keyword}}"` 結果なし |
| 3 | LEARN#12 Rule 2: `git log --oneline origin/main..main` empty | ✅ clean |
| 4 | target file の不在 / 既存性 | ✅ {{verify result}} |
| ... | {{additional checks}} | ✅ |

---

# Scope: {{scope-topic}} (1 item、目安 {{X-Y}}h)

## {{strategic spec}} (原典の要点を embed)

{{spec content from origin doc}}

### Acceptance criteria

{{from origin doc or PM addition}}

### 採用方針 (mandatory)

- **MVP scope**: {{何を MVP として land、stretch を別 PR にするか}}
- **Read-only / 新規依存 / OS 互換** 等の制約
- **既存 X への影響最小化**

### file 構成

```
新規:
  {{new files}}

既存修正:
  {{modified files}}

context 更新:
  {{context updates}}
```

---

# Workflow requirements (LEARN#12 Rule 1、mandatory)

- **Branch**: `feature/{{scope-topic}}` で作業開始、`main` への直 commit **厳禁**
- **PR**: 完了時に `main` 向け PR 作成、body に以下を含める:
  - 実装 summary
  - **test result** (新規 + 既存 regression、件数明記)
  - **LEARN#5 cross-suite grep 結果**
  - **LEARN#6 final branch-wide integration review 結果**
  - {{task-specific verify items}}
- **完了報告の形式**: 「PR URL + test result + {{additional sample/verify items}} + merge 待ち or autonomous merge 可」の **{{N}} 点セット**

違反時 escalation: 完了報告時に branch 外 commit が判明したら PM session が retroactive PR 化を試み、不可能なら LEARN#12 Rule 2 参照。

---

# 着手前 LEARN#10 precheck ({{target-session-type}} 側 mandatory)

PM 側 precheck は YYYY-MM-DD の状態で実施。本 handoff 着手前に以下を再 verify:

```bash
# 1. {{strategic spec}} が現存
grep -nE "{{spec marker}}" {{strategic-origin-doc-path}}

# 2. target file の不在 / 既存性 (drift で既に impl 開始されていないか)
ls {{target-files}} 2>&1

# 3. LEARN#10 逆方向: main にも該当 commit が無いか
git log -10 origin/main --oneline | grep -iE "{{keyword}}"

# 4. {{additional precheck commands}}
```

discrepancy 発見時 → PM session に escalate、本 handoff の更新依頼。**着手前停止が原則**。

---

# Test requirements

## per-item unit test (新規)

新規 test ID **{{TEST-PREFIX}}-*** を `{{test-file-path}}` に追加:

- **{{TEST-PREFIX}}-1**: {{scenario 1}}
- **{{TEST-PREFIX}}-2**: {{scenario 2}}
- ...

## 全 suite regression (LEARN#5、Phase 最後の必須 task)

```bash
node --test tools/claude-brain/tests/hooks/
node --test tools/claude-brain/tests/mcp/
node --test tools/claude-brain/tests/metadata-drift.test.mjs
bash tools/claude-brain/tests/setup-vault.test.sh
bash tools/claude-brain/tests/install-hooks.test.sh
bash tools/claude-brain/tests/install-hooks-gemini.test.sh
bash tools/claude-brain/tests/install-hooks-codex.test.sh
bash tools/claude-brain/tests/auto-ingest.test.sh
bash tools/claude-brain/tests/auto-lint.test.sh
bash tools/claude-brain/tests/scan-secrets.test.sh
bash tools/claude-brain/tests/doctor.test.sh
bash tools/claude-brain/tests/build-mcpb.test.sh
bash tools/claude-brain/tests/sync-to-app.test.sh
bash tools/claude-brain/tests/post-release-sync.test.sh
bash tools/claude-brain/tests/run-quick-suite.sh
```

期待値: 既存全 test pass + 新規 {{TEST-PREFIX}}-* pass。

## LEARN#6 final branch-wide integration review

PR 作成後、自分で以下を検査し PR body に "branch-wide review pass" を記載:

- {{cross-boundary check 1}}
- {{cross-boundary check 2}}

---

# 完了後 PM 側で実施する事 ({{target-session-type}} は触らない)

- handoff 受け取り後、PR review (LEARN#10 trust-but-verify 独立 grep + 実機 verify)
- merge OK なら本 handoff file を **削除** (CLAUDE.md handoff 運用ルール)
- {{related cleanup, release 判定 等}}

---

# 参考 ({{target-session-type}} が参照する正典)

- {{strategic-origin-doc-path}} (本 task 正典 spec)
- {{related code files / scripts}}
- `.claude/rules/code-style.md` (Bash: `set -euo pipefail` / Node.js: ES Module / camelCase)
- `.claude/rules/workflow.md` LEARN#5/#6/#10/#11/#12 (workflow 規約)
- 直前 PR #{{prior}} ({{prior-scope}}、N={{N-1}} delegation の好例)

---

# Metadata

- **委譲開始**: YYYY-MM-DD PM session の RYU 指示
- **想定工数**: {{X-Y}}h
- **target release**: v0.X.Y ({{Sprint N}} {{position}} 番目の PR)
- **delegation pattern**: LEARN#12 codify 後の正規 pattern、PR #{{prior PRs}} で N={{N-1}} 完了済、本 PR で N={{N}} 強化
- **品質優先方針**: RYU 指示「時間かかってもいいから安全でクオリティが高い方」、PM-impl の single point of failure を避け {{target-session}} impl + PM trust-but-verify review の 2 段品質保証
- **2-session origin** (or 3-session): {{describe session role separation}}
```

## scope-specific 入力 (skill 起動時に対話 / pre-filled)

skill 実行時は以下を user に確認 (or 引数 / context から推定):

| 入力 | 説明 | 例 |
|---|---|---|
| `<scope-topic>` | handoff filename + branch name に使う short topic | `v0-7-3-readme-mode-based-setup` |
| `--to=` | 受け手 session type | `制作` (default) / `codex` / `マーケ` |
| **strategic origin doc** | 本 task の出発点となる spec doc path | `plan/codex/260430_*.md §P1` |
| **N counter** | LEARN#12 codification の何 cycle 目か | `N=7` (open-issues や PR history から判定) |
| **MVP scope** | 1-2h で land する最小単位 | "EN+JA README + doctor mode detection" |
| **stretch scope** | MVP land 後 別 PR で OK な拡張 | "8 言語 README" |
| **完了報告 N 点セット** | PR URL + test + その他 evidence の点数 | "5 点セット (PR URL + test + 出力 sample + diff summary + merge OK)" |
| **想定工数** | "1-2h" 等 | LEARN#7 zone 判定の根拠 |

## 動作

1. **入力 prompt**: 上記 8 項目を user に inline 確認 (省略可は default 適用)
2. **filename auto-generate**: `YYMMDDNN_<scope-topic>-delegation.md`
3. **template 展開**: 上記 boilerplate に user 入力を merge
4. **save**: `tools/claude-brain/handoff/<filename>` に書き込み
5. **next action 提示**:
   ```
   handoff doc 作成完了: tools/claude-brain/handoff/{{filename}}

   次:
   1. branch + PR + main hygiene check + merge
   2. RYU が {{target-session}} session を spawn して以下 prompt 投入:
      "tools/claude-brain/handoff/{{filename}} を読んで実装してください"
   ```

## 過去 handoff 例 (template fill 参考)

PR #84 doctor MVP (N=3): scope spec L147-200 from codex roadmap、target files = `scripts/doctor.sh` + `tests/doctor.test.sh` + `context/26-doctor.md`、TEST-PREFIX = `BLUE-DOCTOR-`、想定工数 4-6h、4 点セット完了報告

PR #89 metadata drift test (N=4): scope = §44 incident codification、target = `tests/metadata-drift.test.mjs` + `context/27-metadata-drift.md`、TEST-PREFIX = `BLUE-DRIFT-`、想定工数 4-6h、4 点セット

PR #90 URL test 安定化 (N=5): scope = quick/full suite 分離、target = 10 既存 url test file + `tests/run-{quick,full}-suite.sh`、想定工数 3-5h、5 点セット (timeout 発火 verify 含む)

PR #96 README mode-based (N=6): scope = Mode A/B/C onboarding + doctor mode detection、target = README.md + README.ja.md + `scripts/doctor.sh` + `tests/doctor.test.sh`、TEST-PREFIX = `BLUE-DOCTOR-MODE-`、想定工数 1-2h、5 点セット

## 関連 (本 skill が参照する正典)

- `.claude/rules/workflow.md` LEARN#5 (cross-suite test) / LEARN#6 (cross-boundary integration review) / LEARN#10 (双方向 PM precheck) / LEARN#11 (release cycle sync boundary) / LEARN#12 (delegation = branch + PR mandatory)
- `.claude/rules/code-style.md` (bash + Node.js style 規約)
- `tools/claude-brain/skills/marketing-release-handoff/SKILL.md` (precedent skill、release-time handoff 自動生成)
- 過去 6 delegation handoff (本 skill の boilerplate 抽出 source、git log で復元可能)

## メタ運用

- **新 N cycle で本 skill 利用** = N counter / Metadata 更新
- **8 cycle 以上経過時に本 skill 自体を refactor**: 共通要素の更なる抽出 / scope-specific 入力の自動推論強化
- **session type 別の specialized variant**: 制作 Claude / codex / マーケ で handoff 内容が大きく異なる場合は別 skill 化検討 (現状は 1 skill で 3 type cover、N=6 cycle 中は 制作 N=6 / codex N=0 / マーケ N=1 で 制作 偏重、要 observe)
