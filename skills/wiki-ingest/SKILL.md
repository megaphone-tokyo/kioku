---
name: wiki-ingest
description: "特定のファイル・ディレクトリ、または最近の git 変更を claude-brain Wiki に取り込む軽量版 ingest。`/wiki-ingest <path>` でパス指定、`/wiki-ingest` 引数なしで最近のコミット差分を対象にする。日常的な単発ingest 用途。プロジェクト全体を一括投入したい時は `/wiki-ingest-all` を使う。"
---

# wiki-ingest

特定ファイル or 最近の git 変更から知見を抽出して claude-brain Wiki に取り込むスキル。`/wiki-ingest-all` の軽量版で、日常的に気になる点だけ Wiki に落とすために使う。

## いつ使うか

- 特定のファイル/ディレクトリの知見だけ Wiki に追加したい時
- 最近の git 差分から設計判断やバグ修正の知見を拾いたい時
- `/wiki-ingest-all` ほど大掛かりにする必要がない時

プロジェクト全体を backfill したい場合は `/wiki-ingest-all` を使うこと。

## 前提

- `$OBSIDIAN_VAULT` が設定され、`$OBSIDIAN_VAULT/wiki/` が存在すること
- 引数なしモードは git リポジトリ内で実行すること

## モード判定

### モード A: パス指定 (`/wiki-ingest <path>`)

引数に 1 つ以上のパス (ファイル or ディレクトリ) が渡されたらこのモード。

```bash
# 例
/wiki-ingest src/auth/strategy.ts
/wiki-ingest docs/architecture/
/wiki-ingest src/middleware/ src/utils/errors.ts
```

### モード B: git 差分 (`/wiki-ingest` 引数なし)

引数が空ならこのモード。最近の git 変更から Claude が判断して知見を抽出する。

## ワークフロー

### Step 0: 環境確認

`/wiki-ingest-all` の Step 0 と同じ:

```bash
test -n "$OBSIDIAN_VAULT" || echo "ERROR: OBSIDIAN_VAULT not set"
test -d "$OBSIDIAN_VAULT/wiki" || echo "ERROR: wiki/ missing"

PROJECT_NAME=$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*/([^/]+)(\.git)?$#\1#' | sed 's/\.git$//')
test -n "$PROJECT_NAME" || PROJECT_NAME=$(basename "$(pwd)")
```

### Step 1: 対象の決定

#### モード A (パス指定)

- 指定されたパスが存在するか `test -e` で確認
- ファイルなら直接読む (Read)
- ディレクトリなら `ls` で中身を確認し、主要なもの (README, index.*, 設計ドキュメント等) を優先して読む
- バイナリ/大きすぎるファイルはスキップ

#### モード B (git 差分)

最近のコミットをまず眺めて範囲を決める:

```bash
git log --oneline -10
git status
```

上の結果を見て Claude が範囲を判断する。固定の `HEAD~N` は使わない。典型的には:

- 直近 1〜3 コミットに明確なテーマがある → その範囲
- コミットが細かくバラバラ → 直近 1 コミットだけ
- 作業途中 (uncommitted) → `git diff` + `git diff --cached` のみ

決めた範囲で差分を取得:

```bash
git diff HEAD~<N>..HEAD --stat       # まず概要
git diff HEAD~<N>..HEAD              # 次に本体 (大きければファイル単位で絞る)
```

**スキップする変更**:
- lint / format / typo 修正
- 依存関係の単純なバージョンバンプ
- ファイル移動・リネームだけのコミット
- 生成物 (dist/, build/, lock ファイル)

### Step 2: 既存 Wiki 監査

`/wiki-ingest-all` の Step 0-3 と同じ:

```bash
ls "$OBSIDIAN_VAULT/wiki/projects/"
ls "$OBSIDIAN_VAULT/wiki/concepts/"
ls "$OBSIDIAN_VAULT/wiki/patterns/"
cat "$OBSIDIAN_VAULT/wiki/index.md"
```

qmd MCP が利用可能ならキーワードで事前検索 (オプショナル)。

### Step 3: 知見の抽出

読み取った内容から以下を探す:

- **設計判断**: なぜこの構造/ライブラリ/アプローチを選んだか
- **バグ修正の根本原因**: なぜそのバグが起きたか、どう直したか
- **新しい技術/ツール**: 初めて導入したライブラリ、設定方法、注意点
- **リファクタリングの意図**: 何を改善したか、どうしてその形になったか
- **パフォーマンス改善**: ボトルネックの特定、測定方法、改善結果
- **セキュリティ対応**: 脆弱性の発見と対策

### Step 4: Wiki への書き込み

vault CLAUDE.md の「ページフォーマット」と「wiki/analyses/ のページフォーマットと保存基準」に従う。書き込み先の判断:

| 抽出した知見の性質 | 書き込み先 |
|---|---|
| このプロジェクト固有の設計判断 | `wiki/projects/<PROJECT_NAME>.md` に追記 |
| 他プロジェクトでも通用する汎用分析/比較 | `wiki/analyses/<topic>.md` (新規 or 更新) |
| 他プロジェクトでも使える設計パターン | `wiki/patterns/<pattern>.md` |
| 汎用的な技術概念 | `wiki/concepts/<concept>.md` |
| プロジェクト固有の重大な設計選択 | `wiki/decisions/<PROJECT_NAME>-<topic>.md` |

**重複の扱い**: 同名ページが既にあれば **新規作成ではなく更新** する (追記/補強/`updated` の書き換え)。vault CLAUDE.md の「重複の扱い」ルールに従う。

書き込み後:

1. `wiki/index.md` に新規ページを追加
2. `wiki/log.md` に記録を追加:

```markdown
## YYYY-MM-DD HH:MM — wiki-ingest
- Project: <PROJECT_NAME>
- Mode: path | diff
- Input: <指定パス> | <git diff range>
- Created/Updated: <ページ一覧>
```

### Step 5: 完了サマリー

```
✅ wiki-ingest 完了
Mode: <path | diff>
Input: <何を対象にしたか>

更新:
- wiki/xxx/yyy.md
- wiki/index.md
- wiki/log.md

次のアクション:
- 内容を Obsidian で確認
- 必要なら /wiki-ingest-all でプロジェクト全体を投入
```

## セキュリティルール

`/wiki-ingest-all` と同じ。特に:

- `.env` の値を読まない
- 認証情報・トークン・シークレットを Wiki に書かない
- 社内 URL・内部 IP・ホスト名を書かない
- 不安な時は書かない

## スキップ判断の基準

以下のどれかに該当したら **書き込まずに終了**:

- 読み取った内容に Wiki に書くほどの知見がない (単なる typo 修正、コメント追加等)
- セキュリティルールに抵触する内容しかない
- 既存 Wiki ページと完全に同じ情報しか得られない

「書くべきことがない」も立派な結論。無理に何か書かない。

## `/wiki-ingest-all` との使い分け

| 用途 | 使うスキル |
|---|---|
| プロジェクト全体の backfill (初回) | `/wiki-ingest-all` |
| プロジェクト全体の再スキャン (大改修後) | `/wiki-ingest-all` |
| 特定ファイルの知見だけ追加 | `/wiki-ingest <path>` |
| 最近の git 変更を拾う | `/wiki-ingest` (引数なし) |
| cron の日次自動取り込み | `auto-ingest.sh` (スキルではなくシェル) |
