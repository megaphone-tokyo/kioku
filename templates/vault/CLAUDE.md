<!--
This file is managed by claude-brain setup-vault.sh.
You can edit freely; it will not be overwritten on subsequent runs.
-->

# LLM Wiki Schema

## この Vault について

この Vault は LLM Wiki パターンに基づく個人ナレッジベースです。
Claude Code が `wiki/` ディレクトリ内のページを作成・更新・維持します。
`raw-sources/` と `session-logs/` は読み取り専用です。絶対に変更しないでください。

## セッション開始時の Wiki 参照ルール

セッション開始時に wiki/index.md が自動注入されます。
以下のルールに従ってください:

1. 注入された目次を確認し、現在のタスクに関連しそうなページを特定する
2. 関連ページがあれば Read ツールで読み、過去の知見を把握してから作業を開始する
3. 該当ページがなければそのまま作業を開始する
4. 作業中に有用な分析・比較・知見を生成した場合は wiki/analyses/ に保存する

## Wiki 検索 (qmd)

`qmd` MCP ツールが利用可能な場合、Wiki の検索に使用してください。
qmd は BM25 全文検索 + ベクトル検索 + LLM リランキングのハイブリッド検索エンジンで、
index.md の目次より高精度に関連ページを発見できます。

### 使い方

- タスク開始前に、関連する過去の知見を qmd で検索すること
- 検索モード:
  - `search`: キーワード検索 (BM25) — 正確な用語がわかっている時
  - `vsearch`: セマンティック検索 — 概念的に似た情報を探す時
  - `query`: ハイブリッド検索 (推奨) — 最も精度が高い
- コレクション:
  - `brain-wiki`: 構造化されたナレッジベース (最優先で検索)
  - `brain-sources`: 生素材 (記事、書籍メモ等)
  - `brain-logs`: セッションログ (特定のセッションを探す時)

### 検索の義務

- 新しいタスクに着手する前に、`brain-wiki` コレクションで関連情報を検索すること
- index.md の目次で該当しそうなページが見つからなくても、qmd で検索すれば見つかることがある
- 検索結果が 0 件の場合のみ、検索なしで作業を開始してよい

### qmd MCP が利用できない場合

qmd MCP ツールが Claude Code から見えない場合 (デーモン未起動・MCP 設定なし等) は、
セッション開始時に注入された wiki/index.md の目次だけで関連ページを判断してください。
qmd は **必須依存ではなく** Phase H (index.md 注入) と併用するオプション層です。

## kioku-wiki MCP サーバー (Phase M / Claude Desktop 向け)

Claude Desktop には Hook システムがないため、セッションログを自動収集できません。
そこで `kioku-wiki` MCP サーバーが Wiki への手動経路を提供します:

- `kioku_search` — Wiki 検索 (qmd MCP と同じ目的、`kioku_*` プレフィックスで重複回避)
- `kioku_read` — wiki/<path>.md の内容を返す
- `kioku_list` — wiki/ ディレクトリツリー
- `kioku_write_note` (推奨) — ユーザーが「保存して」と言ったら呼ぶ。session-logs/ にメモを書き、次回 auto-ingest が wiki/ に構造化する
- `kioku_write_wiki` (上級) — wiki/ への即時直書き。テンプレ準拠だが auto-ingest の整形を経ないので、ユーザーが「すぐ反映」と明示した時だけ使う
- `kioku_delete` — wiki/.archive/ への移動 (復元可能)。wiki/index.md は不可

**通常は qmd MCP の `search` を優先**。kioku-mcp の検索は qmd 不在環境のフォールバック。
**書き込みは原則 `kioku_write_note`**。即時反映が必要なときだけ `kioku_write_wiki`。

## ディレクトリ規約

- `raw-sources/` — 人間が追加する生素材（記事、メモ、PDF 等）。LLM は読むだけ。
- `session-logs/` — Hook が自動生成するセッション記録。LLM は読むだけ。Git には含めない（マシンごとにローカル保持）。
- `wiki/` — LLM が所有する層。ページの作成・更新・削除は全てここで行う。
- `wiki/index.md` — Wiki の目次。全ページのリンクと 1 行サマリー。Ingest のたびに更新する。
- `wiki/log.md` — 時系列の操作ログ。Ingest、Query、Lint のたびに追記する。
- `wiki/analyses/` — 技術比較・ベストプラクティス等の汎用知見。保存基準は下記「wiki/analyses/ のページフォーマットと保存基準」を参照。
- `wiki/projects/` — プロジェクト固有の設計判断・実装詳細。analyses/ と重複しないよう使い分ける。

## ページフォーマット

全ての wiki ページには YAML フロントマターを付ける:

```yaml
---
title: ページタイトル
tags: [concept, typescript, testing]
created:
updated:
sources: 0
---
```

本文はここから。
他のページへのリンクは `[[ページ名]]` 形式で。

## wiki/analyses/ のページフォーマットと保存基準

セッション中に生成した有用な分析・比較・技術調査の結果は `wiki/analyses/` に保存します。
Karpathy LLM Wiki パターンの「良い回答は Wiki の新しいページとして保存すべき。探索も知識ベースに複利的に蓄積される」を実装する層です。

### ページフォーマット

```markdown
---
title: React vs Vue 比較分析
tags: [analysis, react, vue, frontend]
created: 2026-04-15
updated: 2026-04-15
source_session: 20260415-103005-abcd-implement-auth-ui.md
---

## 概要
（分析の要約）

## 比較内容
（詳細な比較・分析）

## 結論
（推奨事項や判断基準）

## 関連ページ
- [[react-hooks]]
- [[vue-composition-api]]
```

`source_session` フィールドで知見の出所を追跡可能にします。
ファイル名は内容を表す kebab-case (例: `react-vs-vue-comparison.md`)。

### 保存する

- 技術の比較分析 (ライブラリ、フレームワーク、アプローチの比較)
- アーキテクチャの調査結果
- パフォーマンス測定・ベンチマーク結果
- 特定プロジェクトに閉じない汎用的なベストプラクティス
- 他プロジェクトでも起こりうる問題の根本原因分析

### 保存しない

- プロジェクト固有の実装詳細 (→ `wiki/projects/` 側に記録)
- 結論が出なかった一時的な試行錯誤
- 単純なコード生成結果

### 重複の扱い

同名のページが既に `wiki/analyses/` に存在する場合は、**新規作成ではなく既存ページを更新する** (内容の追記・補強・`updated` の書き換え)。ページを増殖させない。

### 2 つの保存経路

このディレクトリには 2 つの経路で内容が追加されます:

1. **リアルタイム保存**: セッション中に Claude が自発的に Write する (Phase H の自動注入ルールによる)
2. **Ingest 時の抽出**: `auto-ingest.sh` が session-logs を解析して拾う (リアルタイム保存の漏れを拾うセーフティネット)

両方で同じフォーマット・同じ保存基準に従ってください。

## 操作ワークフロー

### Ingest（取り込み）

1. `raw-sources/` または `session-logs/` の新しいファイルを読む
2. 要点を抽出する
3. `wiki/summaries/` にサマリーページを作成する
4. `wiki/` 内の関連する既存ページを更新する（相互リンク、新情報の追記、矛盾の指摘）
5. `wiki/index.md` を更新する
6. `wiki/log.md` に操作を記録する

### Query（質問）

1. `wiki/index.md` を読んで関連ページを特定する
2. 関連ページを読んで回答を組み立てる
3. 有用な回答は `wiki/analyses/` にページとして保存する
4. `wiki/log.md` に記録する

### Lint（健全性チェック）

以下を確認する:

- ページ間の矛盾
- 新しいソースで上書きされた古い主張
- 内向きリンクのない孤立ページ
- 繰り返し言及されるが専用ページのない概念
- 不足している相互リンク

結果を `wiki/lint-report.md` に書く。

### Session Log Ingest（セッションログの取り込み）

`session-logs/` 内の未処理ログ（`ingested: false`）に対して:

1. ログを読み、設計判断・バグ修正・学んだパターン・技術選択を抽出する
2. 該当する wiki ページを更新する（なければ作成する）
3. フロントマターの `hostname`, `cwd` からプロジェクトを特定し、`wiki/projects/` を更新する
4. フロントマターの `ingested` を `true` に書き換える
5. `wiki/log.md` に記録する

## 命名規約

- ファイル名: kebab-case（例: `typescript-generics.md`）
- 概念ページ: 単数形（例: `dependency-injection.md`, `react-hooks.md`）
- プロジェクトページ: プロジェクト名そのまま（例: `my-saas-app.md`）

## リンク規約

- Wiki 内リンク: `[[ファイル名]]` 形式（Obsidian wiki-link）
- ソースへの参照: `[ソースタイトル](../raw-sources/articles/ファイル名.md)` 形式
- セッションログへの参照: `[セッション YYYY-MM-DD](../session-logs/ファイル名.md)` 形式

## セキュリティルール

Wiki ページおよびセッションログに以下の情報を **絶対に含めない**:

- API キー、トークン、シークレット
- パスワード、認証情報
- SSH 鍵、証明書
- 環境変数の値（変数名は OK、値は NG）
- 個人情報（住所、電話番号、クレジットカード等）
- 社内 URL、内部 IP アドレス

Wiki に記録するのは **知識** であり、**認証情報** ではない。

例:

- ✅ 「S3 バケットを使ってファイルアップロードを実装した」
- ❌ 「`AWS_ACCESS_KEY_ID=AKIA...` を使って S3 に接続した」

`session-logs/` に秘匿情報が記録された場合でも、
Wiki への Ingest 時に必ず除去すること。`session-logs/` 自体は Git 管理対象外
（`.gitignore` で除外）なので、GitHub に push されることはない。
