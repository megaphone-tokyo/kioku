---
name: wiki-ingest-all
description: "現在のプロジェクト全体を網羅的に探索し、設計判断・技術選択・アーキテクチャ・パターン・失敗事例を claude-brain Wiki に一括投入する。`/wiki-ingest-all` で起動。既存プロジェクトの backfill (Wiki にまだ記録されていない過去の知見を 1 回で取り込む) が主用途。新規プロジェクトを初めて Wiki に載せる時にも使える。トークン消費を気にせず深く探索する想定。"
---

# wiki-ingest-all

現在の作業ディレクトリ (`$(pwd)`) にあるプロジェクトを網羅的に読み取り、claude-brain Wiki (`$OBSIDIAN_VAULT/wiki/`) に知見を書き込むスキル。

## いつ使うか

- 既存プロジェクトの知見を **初めて** Wiki に取り込む時 (backfill)
- プロジェクトの全体像を 1 回で Wiki に記録したい時
- 新しいプロジェクトを始めて、最初に構造を Wiki に固定したい時

同じプロジェクトに対して 2 回目以降の実行は **更新モード** として扱い、既存ページを置き換えずに追記・補強する。

## 前提

- `$OBSIDIAN_VAULT` が設定され、`$OBSIDIAN_VAULT/wiki/` が存在すること
- 現在のカレントディレクトリが対象プロジェクトのルートであること
- 初回実行なら、Wiki は空か最小限の状態を想定 (qmd/重複チェックはその前提で動く)

## ワークフロー

### Step 0: 環境確認と既存 Wiki 監査

最初に以下を全て実行する。1 つでも欠けたらユーザーに指示を仰いで中断。

```bash
# 0-1. Vault 確認
test -n "$OBSIDIAN_VAULT" || echo "ERROR: OBSIDIAN_VAULT not set"
test -d "$OBSIDIAN_VAULT/wiki" || echo "ERROR: wiki/ missing; run setup-vault.sh first"

# 0-2. プロジェクト名の決定
PROJECT_NAME=$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*/([^/]+)(\.git)?$#\1#' | sed 's/\.git$//')
test -n "$PROJECT_NAME" || PROJECT_NAME=$(basename "$(pwd)")
echo "Project: $PROJECT_NAME"

# 0-3. 既存 Wiki の監査 (重複回避のため)
ls "$OBSIDIAN_VAULT/wiki/projects/" 2>/dev/null
ls "$OBSIDIAN_VAULT/wiki/concepts/" 2>/dev/null
ls "$OBSIDIAN_VAULT/wiki/patterns/" 2>/dev/null
ls "$OBSIDIAN_VAULT/wiki/decisions/" 2>/dev/null
ls "$OBSIDIAN_VAULT/wiki/analyses/" 2>/dev/null
cat "$OBSIDIAN_VAULT/wiki/index.md"
```

**判断**: `wiki/projects/${PROJECT_NAME}.md` が既に存在する場合は **更新モード**。新規作成ではなく既存ページに追記/補強する (既存内容を破壊しない)。

### Step 0.5: qmd 検索 (利用可能な場合のみ)

qmd MCP ツール (`mcp__qmd__query`) が利用可能なら、プロジェクト名や主要ディレクトリ名で事前検索して既存の関連ページを発見する:

```
mcp__qmd__query(
  collection: "brain-wiki",
  searches: [{type: "lex", query: "<PROJECT_NAME>"}],
  intent: "find existing wiki pages about this project"
)
```

qmd が使えない/0 件でも失敗扱いにしない。Step 0-3 の `ls` だけでも重複回避は成立する。

### Step 1: プロジェクト全体の俯瞰

以下を順に読む。node_modules, .git, dist, build, .next, .venv, __pycache__, target, vendor, .DS_Store は除外。

```bash
# ファイル全体像
git ls-files 2>/dev/null || find . -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/target/*' \
  -not -path '*/.venv/*'
```

### Step 2: 定義ファイルの読み取り

以下を存在する限り全て読む (Read ツール):

1. **プロジェクト定義**: `README.md`, `README`, `CLAUDE.md`, `AGENTS.md`, `context.md`, `context/*.md`
2. **技術スタック**: `package.json`, `pnpm-lock.yaml` or `yarn.lock` の上位、`Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, `composer.json`, `build.gradle`, `pom.xml`
3. **設定**: `tsconfig*.json`, `.eslintrc*`, `.prettierrc*`, `biome.json`, `vite.config.*`, `next.config.*`, `webpack.config.*`
4. **インフラ**: `Dockerfile`, `docker-compose.yml`, `.github/workflows/*.yml`, `.gitlab-ci.yml`, `terraform/*.tf`
5. **環境変数**: `.env.example`, `.env.sample`, `.env.template` (**値は読まない、変数名だけ**)
6. **ドキュメント**: `docs/**`, `ADR/**`, `CHANGELOG.md`, `ARCHITECTURE.md`
7. **エントリポイント**: `src/index.*`, `src/main.*`, `app/page.*`, `cmd/*/main.go`, `lib/index.*`

### Step 3: アーキテクチャ探索

`src/`, `app/`, `lib/`, `pkg/`, `internal/` 等のメインディレクトリを 1 階層ずつ読み、以下を把握:

- レイヤー構造 (MVC / clean architecture / hexagonal 等)
- ルーティング方式 (file-based / decorator / 明示登録)
- データアクセス層 (ORM / 生 SQL / repository pattern)
- 認証/認可のエントリポイント
- エラーハンドリングの共通処理
- ミドルウェア/インターセプタ

大きすぎて全部読めない場合は **主要なエントリポイントから依存を辿る** 方式にする。ファイルを全部 grep で舐めようとしない。

### Step 4: テスト構成

`tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*` の配置と、テストフレームワーク (jest, vitest, pytest, go test, rspec 等) を確認。カバレッジ設定 (`jest.config`, `vitest.config`) があれば読む。

### Step 5: チェックポイント (対話確認)

ここで一度ユーザーに要約を提示する:

> 「プロジェクト **<PROJECT_NAME>** を探索しました。以下を抽出する予定です:
>
> - プロジェクトページ: `wiki/projects/<PROJECT_NAME>.md` (新規/更新)
> - 技術スタック: ...
> - アーキテクチャパターン: ...
> - 新規作成予定の concept/pattern/decision ページ:
>   - `wiki/concepts/xxx.md`
>   - `wiki/patterns/yyy.md`
> - 既存ページへの追記予定: (Step 0-3 で見つけたもの)
>
> このまま書き込んで良いですか？ (yes / 一部スキップ / キャンセル)」

ユーザー承認を得てから Step 6 に進む。token を惜しまない設計なのでここは **必ず** 挟む。

### Step 6: Wiki への書き込み

vault CLAUDE.md の「ページフォーマット」と「ディレクトリ規約」に従って以下を書き込む。

#### 6-1. プロジェクトページ (必須、1 枚)

**パス**: `wiki/projects/<PROJECT_NAME>.md`

```markdown
---
title: <PROJECT_NAME>
tags: [project, <技術1>, <技術2>]
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: wiki-ingest-all
---

## 概要
(プロジェクトの目的、README から要約)

## 技術スタック
(package.json / Cargo.toml 等から列挙)

## アーキテクチャ
(Step 3 の探索結果。レイヤー、ルーティング、データアクセス)

## 主要エントリポイント
- `path/to/entry.ts` — <役割>

## テスト戦略
(フレームワーク、配置、カバレッジ方針)

## デプロイ/インフラ
(Docker, CI/CD, クラウド構成)

## 設計判断 (ハイライト)
- (context.md や ADR から拾った判断)

## 既知の技術的負債
(TODO / FIXME / HACK のうち重要なもの)

## 関連ページ
- [[<concept1>]]
- [[<pattern1>]]
```

#### 6-2. 汎用 concept ページ (必要に応じて)

プロジェクト固有ではなく **他プロジェクトでも通用する概念** (例: `nextjs-app-router`, `prisma-orm`, `bun-runtime`) は `wiki/concepts/` に書く。既に存在するなら **更新**。

#### 6-3. 再利用可能 pattern ページ

- エラーハンドリングミドルウェア
- 認証ストラテジ
- DB migration の運用
- 等、コード中で繰り返し現れるパターンは `wiki/patterns/` に書く

#### 6-4. 設計判断 decision ページ

context.md や ADR に書かれている「なぜこの技術/構成を選んだか」は `wiki/decisions/<PROJECT_NAME>-<topic>.md` に書く (例: `projectA-auth-jwt-vs-session.md`)。

#### 6-5. analyses (汎用分析のみ)

プロジェクトを読んで **他プロジェクトでも役立つ汎用分析** (例: "Prisma vs Drizzle 比較") があれば `wiki/analyses/` に。**プロジェクト固有の詳細は入れない** (vault CLAUDE.md の明確な区分)。

#### 6-6. index.md の更新

新規ページを追加したら `wiki/index.md` の目次に 1 行ずつ追記する。既存エントリの順序は壊さない。

#### 6-7. log.md への記録

`wiki/log.md` に Ingest 記録を追記:

```markdown
## YYYY-MM-DD HH:MM — wiki-ingest-all
- Project: <PROJECT_NAME>
- Created: <count> pages (<list>)
- Updated: <count> pages (<list>)
- Source: <$(pwd)>
```

### Step 7: raw-sources に控えを保存

プロジェクトに `context.md` や `CLAUDE.md` があれば、そのコピーを `raw-sources/ideas/<PROJECT_NAME>-context.md` に保存する:

```markdown
---
title: <PROJECT_NAME> context (copied YYYY-MM-DD)
source_path: <PROJECT_NAME>/<ファイル名の相対パス>
source_project: <PROJECT_NAME>
copied_by: wiki-ingest-all
copied_at: YYYY-MM-DD
---

(元ファイルの内容をそのままコピー)
```

**目的**: 後から「あの Wiki ページの根拠は何か」を辿れるようにする。

### Step 8: 完了サマリー

最後にユーザーに以下を表示:

```
✅ wiki-ingest-all 完了
Project: <PROJECT_NAME>

作成したページ:
- wiki/projects/<PROJECT_NAME>.md
- wiki/concepts/xxx.md
- wiki/patterns/yyy.md

更新したページ:
- wiki/index.md
- wiki/log.md
- (既存ページがあればそれも)

raw-sources に控え: raw-sources/ideas/<PROJECT_NAME>-context.md (あれば)

次のアクション:
- Obsidian で確認
- 別プロジェクトに cd して再度 /wiki-ingest-all
```

## セキュリティルール (厳守)

vault CLAUDE.md のセキュリティルールを全て守る。特にこのスキル固有:

- `.env`, `.env.local`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `secrets.yaml` 等は **絶対に読まない**
- `.env.example` / `.env.sample` は変数名のみ記録、値は記録しない
- コード中のハードコードされたトークン/API キーを見つけても Wiki に転記しない (むしろ「ハードコードされた認証情報あり」と警告だけ書く)
- 社内 URL、内部 IP、ホスト名は記録しない
- データベース接続文字列の実値は記録しない

不安な時は **書かない** を選ぶ。Wiki は **知識** を保存する場所で、**認証情報** を保存する場所ではない。

## 運用ガイド: 10 プロジェクトを backfill する流れ

```bash
# 1 個目: まず 1 プロジェクトで試す
cd ~/projects/projectA
# Claude Code で /wiki-ingest-all
# → Step 5 のチェックポイントで出力を吟味
# → 問題なければ yes で Step 6 に進む

# Obsidian で wiki/projects/projectA.md を目視確認

# 2 個目以降: パターンが固まったら連続実行
cd ~/projects/projectB
# /wiki-ingest-all
# (以下、projectC, projectD, ... と繰り返す)

# 完了後、MacBook で commit & push
cd "$OBSIDIAN_VAULT/.."
git status
git add main-claude-brain/wiki/ main-claude-brain/raw-sources/
git commit -m "wiki: backfill N projects via wiki-ingest-all"
git push
```

**事故を防ぐコツ**: 最初の 1 プロジェクトは必ずチェックポイント (Step 5) を有効にして出力を吟味する。2 個目からは流す判断をしてもよい。

## `/wiki-ingest` との使い分け

| 用途 | 使うスキル |
|---|---|
| プロジェクト全体を 1 回で Wiki に載せる | `/wiki-ingest-all` (このスキル) |
| 特定ファイルだけ Wiki に反映 | `/wiki-ingest <path>` |
| 最近の git 変更だけ Wiki に反映 | `/wiki-ingest` (引数なし) |

## トラブルシューティング

- **Vault が空すぎてどう書けばいいか分からない**: vault CLAUDE.md の「ページフォーマット」節を読む。それに沿って書けばよい
- **既存プロジェクトページと衝突した**: 更新モードで既存を尊重しつつ新情報を追記する。既存の情報を削除しない
- **巨大なモノレポで全部読めない**: Step 3 で「主要エントリポイントから依存を辿る」方式に切り替える。全部読もうとしない
- **プロジェクト名が取れない**: ユーザーに聞く (例: 「このプロジェクトの Wiki 上の名前は何にしますか？」)
