---
name: marketing-release-handoff
description: "KIOKU の release (v0.X.Y tag publish) 後に、PM → マーケ担当への引き継ぎ資料を `tools/claude-brain/marketing/handoff/YYMMDDNN_v{VERSION}-release-summary.md` (NN = 同日 N 件目の連番) として自動生成する。Changelog + release PRs から user-facing 変化だけを抽出し、バグ fix / 内部 refactor / LEARN 組織知は除外。記事ネタ候補 3 本 + 想定読者 + 既存 article 資産 pointer 付き。`/marketing-release-handoff v0.7.0` のように version 引数で起動、省略時は kioku 最新 tag を自動検出。"
---

# marketing-release-handoff

KIOKU の release 直後に **PM session (本 skill 起動者) がマーケ部に投げる引き継ぎ資料** を構造化して生成する skill。バグ fix や内部改善は除外し、**user が touch できる価値 + 訴求角度 + 記事ネタ** のみに絞った markdown を `tools/claude-brain/marketing/handoff/` に保存する。

## いつ使うか

- KIOKU の release (v0.X.Y tag) を publish した直後
- マーケ部に「何が出たか / 何を訴求できるか」を PM side から説明したい時
- 記事ネタ候補 (dev.to / Qiita / Zenn) を構造化して引き渡したい時

**使わない場面**:
- Patch release (v0.X.Y hotfix) で user-facing な変化が無い時 → 手動で省略判断
- マーケ担当が自力で Changelog 解読する運用に戻したい時 → 本 skill は PM→マーケ の橋渡し用

## 前提

- release 作業 (tag + .mcpb + GitHub Release + README Changelog 10 言語) が既に完了していること
- `tools/claude-brain/app/README.md` の Changelog に **対象 version の entry** が存在すること
- 参照正典: `tools/claude-brain/marketing/handoff/kioku-marketing-handover.md` (マーケ運用鉄則)、`.claude/rules/marketing.md` (マーケ関連 file 配置ルール)

## 起動

```
/marketing-release-handoff v0.7.0
```

引数省略時 (`/marketing-release-handoff`) は kioku 最新 tag を `gh api repos/megaphone-tokyo/kioku/tags` で自動検出。

## 実行手順 (skill 本体の処理)

### Step 1: Release info 収集

1. **VERSION を確定**: slash command 引数 (例: `/marketing-release-handoff v0.7.0` の `v0.7.0`) が与えられていればそれを使う。省略時は latest tag を Bash で取得:

   ```bash
   gh api 'repos/megaphone-tokyo/kioku/tags?per_page=1' --jq '.[0].name'
   ```

   ※ この snippet 内の `$1` / `${1:-...}` を slash command 引数と**混同しないこと**。skill は引数を prompt 文脈で受け取り、shell 位置引数は空。`<VERSION>` は以降 `v0.7.0` 等の確定値に置換して使う。

2. **tag 情報と published 日を取得**:

   ```bash
   gh release view "<VERSION>" --repo megaphone-tokyo/kioku --json tagName,publishedAt,assets
   ```

3. **handoff filename の日付 + NN 連番を決定**: publishedAt を YYMMDD 形式に変換 (例: 2026-04-24 → 260424)、NN は既存 handoff の同日件数 +1 を `ls tools/claude-brain/marketing/handoff/ | grep "^<YYMMDD>"` で数えて決定 (該当無しなら `01`)。

### Step 2: Changelog 該当 entry 抽出 (LEARN#10 準拠)

1. **必ず** 以下 grep で heading 実在を verify (LEARN#10 精読必須):

   ```bash
   grep -n "^### .*— <VERSION>:" tools/claude-brain/app/README.md
   ```

   **hit 無し → 即 abort**。推測ベースで handoff 本文を書かず、user に以下を報告:
   > Changelog entry 未作成の可能性。release cascade (parent PR → sync-to-app → kioku README PR → kioku main merge → post-release-sync) が完了していない疑い。LEARN#11 の 4 step を確認してください。

2. hit あり → 該当行から次の `### ` 見出しまでを範囲として抽出する。README.md が master、10 言語 i18n parity は前提 (抽出は EN master から)。

### Step 3: User-facing filter

抽出した Changelog から以下を **除外**:
- "bug fix" / "hotfix" / "regression" / "silent" を含む行
- "internal" / "refactor" / "test" で始まる行
- "LEARN#" で始まる行 (組織知、マーケ外)
- "version bump" / "parity" / "i18n fix" 等の裏方 item

**残すもの** = user が install / setup / 日常使用で体感する変化。

### Step 4: Before / After 再構成

各 feature について以下の 3 点セットで書く:
1. **Before**: v0.(X-1).Y の状態、user が何に困っていたか
2. **After**: v0.X.Y で user が何ができるようになったか (必要ならコード例)
3. **なぜ重要**: マーケ的 narrative (target persona、差別化 angle)

### Step 5: 記事ネタ候補 3 本提案

release の key feature から 3 つの article angle を生成:
- 各 angle に **想定読者** (persona) を明示
- 対象媒体 (dev.to 英語 / Qiita 日本語技術 / Zenn 日本語広め) を提案
- 既存 article `tools/claude-brain/marketing/article/<媒体>/YYMMDD_kioku-v0.(X-1)-<媒体>.md` のフォーマットを踏襲する旨を明記

### Step 6: Save

`tools/claude-brain/marketing/handoff/{YYMMDDNN}_v{VERSION}-release-summary.md` として save。

- YYMMDD は release 日 (tag publishedAt 由来)
- NN は同日 N 件目 handoff の連番 (既存 handoff file を ls して決定)
- frontmatter に PM 属性 + from/to/created/purpose/status/related を入れる

**related field の埋め方** (出力 template の `plan/claude/XXXXX` は placeholder、必ず解決 or 削除):

- `handoff/post-release-{VERSION}.md`: 存在すれば記載、無ければ omit
- `plan/claude/<YYMMDDNN>_*`: Changelog entry 中に plan/claude 参照があればそれを採用。無ければ `plan/claude/` 配下で該当 Phase を `ls -la | grep -i <feature-keyword>` で 1 候補に絞って記載。**確信が持てなければ omit して PM に照会** (推測で埋めない、LEARN#10 準拠)
- `README.md Changelog §{YYYY-MM-DD}`: 必須

### Step 7: 報告

作成 file path と主要 section の proof を console に出す。マーケ担当への共有文言サンプルも提示:
> 「PM から v0.7.0 の release 申し送り書が marketing/handoff/26050101_v0-7-0-release-summary.md に入りました。article draft 展開お願いします。」

## 出力 template (frontmatter + 構造)

```markdown
---
title: KIOKU {VERSION} リリース概要 — マーケ部向け説明資料
from: PM Claude ({起動時の session 文脈})
to: マーケティング戦略部 / マーケ担当 Claude
created: {YYYY-MM-DD}
purpose: {VERSION} リリースをマーケ部に説明するための構造化資料。バグ fix / 内部改善は除外、user が touch できる価値のみに絞る
status: PM からの申し送り、以降 article 展開・SNS 展開・LP 素材化はマーケ担当管轄
related:
  - handoff/post-release-{VERSION}.md (PM 側 observation checklist、あれば)
  - plan/claude/XXXXX (該当 Phase roadmap)
  - README.md Changelog §{YYYY-MM-DD} (user 向け一次情報)
---

# 📌 PM からの説明 (冒頭)

本 document は **PM Claude が {VERSION} リリースの中身をマーケ部向けに整理した申し送り** です。技術 side (PM) が「何が出たか / なぜ重要か / どう訴求できるか」に翻訳し、マーケ担当 (別 Claude session + RYU) に渡します。

**ルール**:
- 本 file 以降の article draft 作成 / X 投稿 / note.com 記事 / LP 素材化はマーケ担当の管轄 (`tools/claude-brain/marketing/article/`)
- PM side は実装 / release / observation が守備範囲
- 事実確認はマーケ担当 → PM session に照会してください
- `.claude/rules/marketing.md` + `feedback_marketing_separation.md` (memory) 準拠。**本 file は PM が marketing/ 配下に書く RYU 明示例外**: release 申し送りは PM 主導、以降の article 展開・SNS 展開・LP 素材化はマーケ担当管轄

---

# 📢 KIOKU {VERSION} リリース概要

**リリース日**: {YYYY-MM-DD}
**タグライン案**: "{1 行 narrative}"

## 🌟 {N} つの大きな user 変化

### 1. {Feature 1}

**Before**: ...
**After**: ...
**なぜ重要**: ...

(... 各 feature について繰り返し)

---

## 🛡 セキュリティ姿勢の強化 (該当 release なら)

...

---

## 🔮 次バージョン ({next}) への仕込み

内部で {...} 実装済 (user には見えない)。{next} で以下が出ます:
- ...

**なぜ marketing 的に重要**: ...

---

## 💬 {next}+ へ延期 (問い合わせ対応 FAQ)

| 項目 | 状態 / 予定時期 |
|---|---|
| ... | ... |

---

## 📣 記事ネタ候補 (3 本、マーケ担当が draft 化)

### A. "{タイトル}" ({媒体})
- ...
- **想定読者**: ...

### B. ...
### C. ...

---

## 📥 Release リンク

- **GitHub Release**: https://github.com/megaphone-tokyo/kioku/releases/tag/{VERSION}
- **`.mcpb` Direct**: https://github.com/megaphone-tokyo/kioku/releases/download/{VERSION}/kioku-wiki-{VERSION_NO_V}.mcpb
- **SHA-256**: `{sha}`

---

## 🤝 マーケ担当への引き継ぎ

### 既存 article 資産

`tools/claude-brain/marketing/article/` 配下に過去 release 記事あり。{VERSION} 記事を書く際は v0.(X-1) 記事 (dev.to / Qiita / Zenn 3 媒体) のフォーマットを踏襲推奨。

### マーケ運用鉄則

`tools/claude-brain/marketing/handoff/kioku-marketing-handover.md` を正典として参照。

### 疑問があれば PM へ照会

本資料の事実関係 (何が実装されたか / どの PR / test coverage / release 時期) は PM session で確認可能。

---

## 📌 Metadata

- 本 file 作成時の parent main: `{sha}`
- kioku main: `{sha}`
- kioku tag: `{VERSION}` — published {timestamp}
- PM session 今日の merged PR: {list}
```

## Reference example

最初の実例は **`tools/claude-brain/marketing/handoff/26042404_v0-6-0-release-summary.md`** (v0.6.0 release、2026-04-24)。文体・粒度・記事ネタの書き方はこれを基準にする。

## マーケ運用ルール整合

- `.claude/rules/marketing.md` 準拠: marketing/ 配下への保存、YYMMDD_topic.md 命名
- `feedback_marketing_separation.md` 例外: 本 skill は PM が起動するが、出力は marketing/ に入る (RYU 明示の許可運用)
- `feedback_handoff_script_verify.md` (LEARN#10) 準拠: Changelog 抽出前に `### YYYY-MM-DD — {VERSION}` heading の実在を grep で verify

## Test (skill 自体には test 不要、ただし出力検証)

本 skill が生成した handoff は PM が目視で以下 check:
- [ ] user-facing filter が正しく効いているか (bug fix / LEARN が混入していないか)
- [ ] Before / After 3 点セットが全 feature に揃っているか
- [ ] 記事ネタ 3 本に想定読者が明記されているか
- [ ] Release URL / SHA-256 が正しいか
- [ ] frontmatter の `from` / `to` / `related` が埋まっているか

生成物に不備があれば skill ロジックを改訂 (PR で `SKILL.md` 修正)。
