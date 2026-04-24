## マニュアルは多言語化されています

> [!NOTE]
> **🌐 他の言語:** [🇬🇧 English](README.md) · 🇯🇵 **日本語** · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#前提条件)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code は過去のセッションで得た知識をどんどん忘れてしまいます。
KIOKU はあなたが Claude と話した記憶を**自動で Wiki に蓄積**し、**次のセッションで呼び戻せる**ようにします。

これまでのように同じ説明を何度も繰り返す必要はありません。

使うほどに育つ「second brain（第二の脳）」を、あなたの Claude に。

<br>

## 何をするツールか

Claude Code のセッションを自動で記録し、Obsidian Vault 上に構造化されたナレッジベースを作成するツールです。

Andrej Karpathy の LLM Wiki パターン に、自動ログ収集と Git 同期 の仕組みを組み合わせ、複数マシン間で共有できるようにしました。


```
🗣️  いつも通り Claude Code と会話する
         ↓  （自動で記録される — あなたは何もしなくていい）
📝  セッションログがローカルに保存される
         ↓  （定期ジョブが AI にログを読ませ、知識を抽出する）
📚  Wiki がセッションごとに育つ — 概念、設計判断、パターン
         ↓  （Git で同期）
☁️  GitHub が Wiki をバックアップし、複数マシン間で共有する
```

1. **自動収集 (L0)**: Claude Code の Hook イベント（`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`）を捕捉して、Vault の `session-logs/` に Markdown を書き出します
2. **構造化 (L1)**: 定期実行（macOS LaunchAgent / Linux cron）で `session-logs/` の未処理ログを LLM が読み、`wiki/` に概念ページ・プロジェクトページ・設計判断の記録を作ります。セッションの知見は `wiki/analyses/` にも保存されます
3. **整合性チェック (L2)**: 月次で Wiki 全体の健全性をチェックし `wiki/lint-report.md` を生成。秘密情報の漏れ検知も自動実行します
4. **同期 (L3)**: Vault 自体を Git リポジトリにし、`SessionStart` で `git pull`、`SessionEnd` で `git commit && git push` することで、複数 Mac 間を GitHub Private リポジトリ経由で共有します
5. **Wiki コンテキスト注入**: `SessionStart` 時に `wiki/index.md` をシステムプロンプトに注入し、過去の知識を活用できます
6. **qmd 全文検索**: MCP 経由で wiki を全文検索・セマンティック検索できます
7. **Wiki Ingest スキル**: `/wiki-ingest-all` / `/wiki-ingest` スラッシュコマンドで、既存プロジェクトの知識を Wiki に取り込めます
8. **機密の隔離**: `session-logs/` はマシンごとにローカル保持（`.gitignore` 対象）。`wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` のみが Git 管理対象になります

<br>

## 注意事項

> [!CAUTION]
> claude-brain は現在 **Claude Code（Max プラン）** が必要です。Hook システム (L0) と Wiki コンテキスト注入は Claude Code 固有の機能です。Ingest/Lint パイプライン (L1/L2) は `claude -p` の呼び出しを差し替えることで他の LLM API でも動作可能 — これは将来の拡張として計画中です。

> [!IMPORTANT]
> 本ソフトウェアは **「現状のまま」** 提供されます。いかなる種類の保証もありません。作者は、本ツールの使用によって生じた**データの損失、セキュリティインシデント、その他の損害について一切の責任を負いません**。自己責任でご使用ください。詳細は [LICENSE](../../LICENSE) をご確認ください。

<br>

## 前提条件

| | バージョン / 要件 |
|---|---|
| macOS | 13+ 想定 |
| Node.js | 18+（Hook スクリプトは `.mjs` ES Module、外部依存なし） |
| Bash | 3.2+（macOS 標準） |
| Git | 2.x 以上。`git pull --rebase` / `git push` が使えること |
| GitHub CLI | 任意（`gh` を使うと Private リポジトリの作成が簡単） |
| Claude Code | **Max プラン** が必要（`claude` CLI と `~/.claude/settings.json` の Hook システムを使用） |
| Obsidian | 任意のフォルダに Vault を 1 つ作成済み（iCloud Drive 上でなくてよい） |
| jq | 1.6+（`install-hooks.sh --apply` で使用） |
| poppler | 任意（推奨）。PDF 取り込みに使用。`brew install poppler` (macOS) / `apt install poppler-utils` (Debian/Ubuntu) で追加。未インストール時は `raw-sources/` 配下の PDF は静かにスキップされる。 |
| 環境変数 | `OBSIDIAN_VAULT` で Vault ルートを指定 |

<br>

## クイックスタート

> [!WARNING]
> **インストール前にご理解ください:** claude-brain は Claude Code の**全セッション入出力**にフックします。これは以下を意味します:
> - セッションログにプロンプトやツール出力の **API キー、トークン、個人情報** が含まれる可能性があります。マスキングは主要なパターンをカバーしますが完全ではありません — [SECURITY.md](SECURITY.md) を確認してください
> - `.gitignore` の設定が壊れると、セッションログが **誤って GitHub に push される** 可能性があります
> - auto-ingest パイプラインはセッションログの内容を `claude -p` 経由で Claude に送信し、Wiki の知識を抽出します
>
> まず `KIOKU_DRY_RUN=1` でパイプラインを確認してから本番運用を開始することを推奨します。

### 🚀 対話式セットアップ (推奨)

> [!NOTE]
>Claude Code で以下を入力すると、対話形式でセットアップを進められます。各ステップの意味と意図を説明しながら、あなたの環境に合わせてガイドします。

```
tools/claude-brain/skills/setup-guide/SKILL.md を参照して、claude-brain のインストール作業をしてください。
```

### 🛠️ マニュアルセットアップ

> [!NOTE]
> 各ステップを自分で理解しながら進めたい方向け。スクリプトを直接実行していきます。

#### 1. Vault を作成し Git リポジトリと接続する（ユーザー作業）

1. Obsidian で新規 Vault を作成（例: `~/claude-brain/main-claude-brain`）
2. GitHub で Private リポジトリを作成（例: `claude-brain`）
3. Vault ディレクトリで `git init && git remote add origin ...` を行う（or `gh repo create --private --source=. --push`）

この手順は claude-brain のスクリプトでは自動化しません。GitHub 認証（gh CLI / SSH 鍵）はユーザー環境に依存するため、責任境界を分けています。

#### 2. 環境変数を設定

```bash
# ~/.zshrc に追記
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

#### 3. Vault の初期化

```bash
# Vault 配下に raw-sources/, session-logs/, wiki/, templates/ を作り、
# CLAUDE.md / .gitignore / 初期テンプレートを配置する（既存ファイルは上書きしない）
bash tools/claude-brain/scripts/setup-vault.sh
```

#### 4. Hook のインストール

```bash
# 方法 A: 自動マージ（推奨。jq が必要）
bash tools/claude-brain/scripts/install-hooks.sh --apply
# バックアップ作成 → diff 表示 → 確認プロンプト → 既存設定を保持したまま Hook エントリを追加

# 方法 B: 手動マージ
bash tools/claude-brain/scripts/install-hooks.sh
# stdout に出力されたスニペットを ~/.claude/settings.json に手動でマージ
```

#### 5. 動作確認

Claude Code を再起動してから、何か 1 つ会話を行うと
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` が生成されるはずです。

> **ここまでが必須ステップです。** 以下は任意ですが、フル活用するなら設定を推奨します。

#### 6. 定期実行のセットアップ（推奨）

自動 Ingest（毎日）と自動 Lint（毎月）の定期実行を設定します。

```bash
# macOS では LaunchAgent、Linux では cron を自動判別してインストール
bash tools/claude-brain/scripts/install-schedule.sh

# まず DRY RUN で経路を確認
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **macOS の注意**: `~/Documents/` や `~/Desktop/` 配下にリポを置くと TCC (Transparency, Consent, Control) が
> バックグラウンドアクセスをブロックし EPERM になります。`~/_PROJECT/` など保護対象外のパスを推奨します。

手動で 1 回だけ取り込みたい場合は、スクリプトを直接叩けば同じ処理が走ります。

#### 7. qmd 検索エンジンのセットアップ（任意）

Wiki を MCP 経由で全文検索・セマンティック検索できるようにします。

```bash
# qmd コレクション登録 + 初回インデックス
bash tools/claude-brain/scripts/setup-qmd.sh

# qmd MCP HTTP サーバーを launchd 常駐（macOS のみ）
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

#### 8. Wiki Ingest スキルの配置（任意）

`/wiki-ingest-all`（既存プロジェクト一括取り込み）と `/wiki-ingest`（ターゲットスキャン）を使えるようにします。

```bash
# ~/.claude/skills/ に symlink を配置
bash tools/claude-brain/scripts/install-skills.sh
```

#### 9. Mac mini などの追加マシンへの展開

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Obsidian で ~/claude-brain/main-claude-brain/ を Vault として開く
# 上記の 2〜6 の手順を繰り返す
```

#### 10. Claude Desktop / Code から Wiki に到達する MCP サーバー (任意)

Claude Desktop には Hook システムがないため、自動では Wiki に何も保存されません。
代わりに **`kioku-wiki` MCP サーバー** を立てておくと、Claude Desktop と Claude Code の両方から Wiki の検索・読み取り・書き込みができます。

```bash
# 1. 依存セットアップ (mcp/ 配下にだけ npm install)
bash tools/claude-brain/scripts/setup-mcp.sh

# 2. 接続確認 (Inspector でブラウザから疎通確認)
npx @modelcontextprotocol/inspector node tools/claude-brain/mcp/server.mjs

# 3. クライアント登録 (まずはプレビュー)
bash tools/claude-brain/scripts/install-mcp-client.sh --dry-run

# 4. 問題なければ反映
bash tools/claude-brain/scripts/install-mcp-client.sh --apply

# 5. Claude Code (CLI / VSCode) には別途登録 (上記 stdio コマンドで案内される)
claude mcp add --scope user --transport stdio kioku \
  "$(command -v node)" "$(pwd)/tools/claude-brain/mcp/server.mjs"
```

提供される 9 ツール:

| ツール | 用途 |
|---|---|
| `kioku_search` | Wiki 全文検索 (qmd 委譲、qmd 不在時は Node 簡易 grep) |
| `kioku_read` | wiki/<path>.md の内容を返す |
| `kioku_list` | wiki/ ディレクトリツリー |
| `kioku_write_note` (推奨) | session-logs/ にメモを書き出し、次回 auto-ingest が wiki/ に構造化 |
| `kioku_write_wiki` (上級) | wiki/ への即時直書き (テンプレ準拠、frontmatter 自動付与) |
| `kioku_delete` | wiki/.archive/ への移動 (復元可能、index.md 不可) |
| `kioku_ingest_document` (機能 2.4) | **統一 ingest router**。`raw-sources/` 配下のローカルドキュメントを拡張子で dispatch — `.pdf` / `.md` → PDF handler、`.epub` → EPUB handler (yauzl + 8 層防御 + readability → 章単位 Markdown chunk)、`.docx` → DOCX handler (mammoth + yauzl + XXE pre-scan → 単一 Markdown chunk)。画像 / OLE 埋め込みは安全性のため MVP では skip |
| `kioku_ingest_pdf` (機能 2.1、deprecation alias) | `kioku_ingest_document` の `.pdf` / `.md` 限定 alias。v0.5 〜 v0.7 window で残留、v0.8 で削除予定。新規 integration では `kioku_ingest_document` を使用推奨 |
| `kioku_ingest_url` (機能 2.2) | HTTP/HTTPS URL を取得し、Mozilla Readability で本文を抽出 → `raw-sources/<subdir>/fetched/` に Markdown + 画像を保存 → wiki 要約を予約。PDF URL は自動で `kioku_ingest_document` にディスパッチ |

**ポイント**:
- 完全ローカル (stdio、ネットワーク非露出、`@modelcontextprotocol/sdk` のみ依存)
- Desktop からの「保存して」指示は **`kioku_write_note` を優先**。整合性が保たれる
- 即時反映が必要な時だけ `kioku_write_wiki`
- 既存の qmd MCP (HTTP :8181) と共存。検索は qmd MCP の `search` を優先 (kioku_search はフォールバック)

##### 永続性と再実行のタイミング

**一度インストールすれば、再起動後も何もしなくて OK です。** MCP サーバーは Claude Desktop / Claude Code が新しい会話を開くたびに on-demand で起動され、会話終了で自動 kill されます — daemon として常駐管理する必要はありません。OS 再起動 / Desktop の再起動 / Claude Code の再起動すべて、**勝手に動きます**。

以下のケースでのみ再実行が必要:

| 条件 | 再実行するステップ |
|---|---|
| リポを別ディレクトリに移動した | ステップ 3 と 5 (`mcp/server.mjs` の絶対パスが config に焼かれているため) |
| Node のバージョンを切り替えた (mise / nvm / Volta) | ステップ 3 (`command -v node` の絶対パスがハードコードされる) |
| `OBSIDIAN_VAULT` 環境変数を変更した | ステップ 3 (apply 時の値が config に焼き込まれる) |
| `@modelcontextprotocol/sdk` がメジャーアップデートされた | ステップ 1 (`setup-mcp.sh` で `node_modules` を更新) |

アンインストール:

```bash
bash tools/claude-brain/scripts/install-mcp-client.sh --uninstall
rm -rf tools/claude-brain/mcp/node_modules
```

#### 11. Claude Desktop 向け MCPB バンドル（ファイル 1 つでインストール）

**Claude Desktop だけ** を使うユーザー向けに、MCP サーバーを [MCPB](https://github.com/anthropics/mcpb) バンドルとして配布できます。`.mcpb` ファイルを 1 つドラッグ & ドロップするだけでインストール完了。バンドルには `mcp/server.mjs` と本番依存 (`@modelcontextprotocol/sdk`) が同梱されており、Claude Desktop は内蔵 Node ランタイムでバンドルを起動するため、**エンドユーザー側で Node をインストールする必要はありません**。

##### Option A — ビルド済みリリースをインストール（エンドユーザー推奨）

1. [github.com/megaphone-tokyo/kioku/releases](https://github.com/megaphone-tokyo/kioku/releases) から最新の **`kioku-wiki-<version>.mcpb`** をダウンロード
2. **Claude Desktop** を起動
3. 以下のいずれか:
   - Finder で `.mcpb` ファイルを **ダブルクリック**（macOS は `.mcpb` を Claude Desktop に関連付けている）、または
   - **設定 → Extensions / Connectors** 画面を開き、`.mcpb` をその画面にドラッグ
   - （チャット画面に投げないこと — ファイル添付として扱われてしまう）
4. インストールダイアログで **Vault directory**（`wiki/` / `session-logs/` / `raw-sources/` を含むフォルダ）を picker から選択 → **Install**
5. **設定 → Connectors** で `KIOKU Wiki` が有効になっていることを確認
6. **新しい** チャットを開いて試す: `kioku_read で wiki/index.md を読んで`（既存チャットには新ツールが反映されません）

> **Note**: Claude Desktop は「Anthropic によって検証されていない拡張機能です」と警告を出します。これは想定内 — `mcpb sign` によるコード署名は今後の予定です。

##### Option B — ソースからビルド（開発者・コントリビューター向け）

```bash
# 1. .mcpb バンドルをビルド (mcp/dist/kioku-wiki-<version>.mcpb 約 3.2 MB が生成される)
bash tools/claude-brain/scripts/build-mcpb.sh

# 2. (任意) manifest 検証 + アーカイブ中身の確認
bash tools/claude-brain/scripts/build-mcpb.sh --validate
npx --yes @anthropic-ai/mcpb info tools/claude-brain/mcp/dist/kioku-wiki-0.1.0.mcpb

# 3. ビルド成果物の掃除
bash tools/claude-brain/scripts/build-mcpb.sh --clean
```

バンドルは **gitignore 対象** (`mcp/build/`, `mcp/dist/`)。新リリース公開時は `build-mcpb.sh` でビルドし、生成された `.mcpb` を [megaphone-tokyo/kioku](https://github.com/megaphone-tokyo/kioku) リポの新しい [GitHub Release](https://github.com/megaphone-tokyo/kioku/releases) に添付してください。エンドユーザーは Option A 経由でダウンロードできます。

手順 10 の従来のインストール経路もそのまま使えます。MCPB は Desktop 中心ユーザー向けの**追加チャンネル**であり、置き換えではありません。

##### 永続性と再インストールのタイミング

**一度インストールすれば、再起動後も `.mcpb` はそのまま動き続けます。** Claude Desktop が新しい会話を開くたびに自動で server プロセスを起動してくれるので、ユーザー側で何かを手動起動する必要はありません。

以下のケースでのみ再インストール:

| 条件 | 対応 |
|---|---|
| Obsidian Vault ディレクトリを移動した | `.mcpb` を再インストール (ダイアログで Vault directory を再入力) または `~/Library/Application Support/Claude/claude_desktop_config.json` を手動編集 |
| 新しい `.mcpb` バージョンがリリースされた | Releases から新しい `.mcpb` をダウンロードして drag-install。Desktop が既存の拡張を上書き更新 |
| 誤って 設定 → Connectors でアンインストールした | 同じ `.mcpb` を再度ドラッグ |

手順 10 と違い、MCPB は自己完結型です — **このソースリポの移動 / Node バージョン切り替え / `@modelcontextprotocol/sdk` アップデート は、インストール済み `.mcpb` に影響しません** (バンドル自体が依存を同梱しており、Desktop 内蔵の Node ランタイムで起動するため)。

> ⚠️ **`.mcpb` を新規インストール / 上書きしたあとは、Claude Desktop を ⌘Q で完全終了してから再起動してください** (ウィンドウを閉じる ⌘W では不十分)。これをやらないと、前に起動済みの MCP サーバープロセスが古い code を memory に保持したまま動き続けます。tools/list の内容 (ツール名や schema) は更新されても、サーバー内部のロジック変更 (バグ修正、バリデーション緩和など) は反映されません。

##### Tips — Claude Desktop で kioku を使うコツ

Claude Code は Hook システム (`session-logger.mjs`) で**毎セッションを自動的に `session-logs/` に記録する**のに対し、**Claude Desktop には Hook システムがありません**。Desktop の会話は自動では Vault に保存されません — 明示的に Claude にお願いする必要があります。

保存をトリガーする言い回し (Claude が description を見て適切なツールを選ぶ):

| 言い方 | 呼ばれるツール | 保存先 |
|---|---|---|
| 「メモして」「保存して」「Wiki に追加して」 | `kioku_write_note` | `session-logs/` → 次回 auto-ingest で `wiki/` に構造化 |
| 「今すぐ Wiki に作って」「即時に反映して」 | `kioku_write_wiki` | `wiki/` に直書き (即時、テンプレ準拠、wikilink 整合は best-effort) |

実践的な習慣: 会話の区切りで **「今の話をまとめてメモしておいて」** **「この設計判断を記録して」** と一言お願いするのがおすすめ。これをやらないと、Desktop での会話は Claude のチャット履歴にしか残らず、Obsidian Vault には反映されません。

Claude Code も併用している場合は、Claude Code 側は **自動記録** (上記ステップ 4 の Hook 経由) なので、何もしなくても Vault に蓄積されます。2 つのクライアントが同じ Vault に書き込むため、**どちらから使っても second brain は育っていきます**。

<br>

## ディレクトリ構成

```
tools/claude-brain/
├── README.md                        ← 本ファイル
├── context/                         ← 現在の実装の正典（INDEX + 機能別ドキュメント）
├── handoff/                         ← 次セッションへの申し送り
├── plan/
│   ├── user/                      ← ユーザーの設計指示書
│   └── claude/                      ← Claude の実装仕様書・議事録
├── hooks/
│   ├── session-logger.mjs           ← Hook 本体（UserPromptSubmit/Stop/PostToolUse/SessionEnd）
│   └── wiki-context-injector.mjs    ← SessionStart で wiki/index.md をシステムプロンプトに注入
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← 既存プロジェクト一括 Wiki 化スラッシュコマンド
│   └── wiki-ingest/SKILL.md         ← ターゲットスキャン スラッシュコマンド
├── templates/
│   ├── vault/
│   │   ├── CLAUDE.md                ← Vault ルートに置く LLM Wiki スキーマ
│   │   └── .gitignore               ← session-logs/, .obsidian/ 等を除外
│   ├── notes/
│   │   ├── concept.md
│   │   ├── project.md
│   │   ├── decision.md
│   │   └── source-summary.md
│   ├── wiki/
│   │   ├── index.md
│   │   └── log.md
│   └── launchd/*.plist.template     ← macOS LaunchAgent テンプレート
├── scripts/
│   ├── setup-vault.sh               ← Vault 初期化（冪等）
│   ├── install-hooks.sh             ← Hook 設定スニペット出力 / --apply で自動マージ
│   ├── auto-ingest.sh               ← 定期実行: 未処理ログを wiki に取り込む
│   ├── auto-lint.sh                 ← 定期実行: wiki 健全性レポート + 秘密情報スキャン
│   ├── install-cron.sh              ← cron エントリを stdout に出力
│   ├── install-schedule.sh          ← OS 分岐 dispatcher（macOS → LaunchAgent / Linux → cron）
│   ├── install-launchagents.sh      ← macOS LaunchAgent インストーラ
│   ├── setup-qmd.sh                 ← qmd コレクション登録 + 初回インデックス
│   ├── install-qmd-daemon.sh        ← qmd MCP HTTP サーバーを launchd 常駐
│   ├── install-skills.sh            ← ~/.claude/skills/ に wiki-ingest 系を symlink 配置
│   └── scan-secrets.sh              ← session-logs/ の秘密情報漏れ検知
└── tests/                           ← node --test と bash スモークテスト
```

<br>

## 環境変数

| 変数 | 既定値 | 役割 |
|---|---|---|
| `OBSIDIAN_VAULT` | なし (必須) | Vault ルート。auto-ingest/lint のみ `${HOME}/claude-brain/main-claude-brain` をデフォルトとしてフォールバック |
| `KIOKU_DRY_RUN` | `0` | `1` にすると auto-ingest/lint が `claude -p` を呼ばず経路確認だけする |
| `KIOKU_NO_LOG` | 未設定 | `1` にすると `session-logger.mjs` が早期 return。cron サブプロセスの再帰ログ防止用 |
| `KIOKU_DEBUG` | 未設定 | `1` にすると stderr と `session-logs/.claude-brain/errors.log` にデバッグ情報を出す |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | auto-ingest のログ出力先（auto-lint の自己診断で参照） |

### Node マネージャーの PATH 設定

定期実行スクリプト (`auto-ingest.sh`, `auto-lint.sh`) は cron / LaunchAgent から呼ばれるため、インタラクティブシェルの PATH を継承しません。スクリプト内で Volta (`~/.volta/bin`) と mise (`~/.local/share/mise/shims`) を PATH に追加していますが、**nvm / fnm / asdf 等の他のバージョンマネージャーを使っている場合**は、スクリプト冒頭の `export PATH=...` 行を環境に合わせて編集してください。

```bash
# 例: nvm を使っている場合
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# 例: fnm を使っている場合
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## 設計上の注意

- **セッションログは機密を含む**: プロンプトや tool 出力に API キー・トークン・PII が入りうるため、`session-logger.mjs` は正規表現マスキングを実装した上で書き出します
- **書き込み境界**: Hook が書き込むのは `$OBSIDIAN_VAULT/session-logs/` のみ。`raw-sources/`, `wiki/`, `templates/` には触りません
- **session-logs は Git に入らない**: `.gitignore` で除外されるため、誤って GitHub に push されるリスクは低く抑えます
- **ネットワーク禁止**: Hook スクリプト（`session-logger.mjs`）は `http`/`https`/`net`/`dgram` を import しません。Git 同期は Hook 設定側のシェルワンライナーで行うため、Node コード内にネットワーク処理は入りません
- **冪等性**: `setup-vault.sh` / `install-hooks.sh` は何度実行しても既存ファイルを壊しません
- **git init はしない**: `setup-vault.sh` は Git リポジトリ初期化・remote 追加を行いません。GitHub 認証はユーザーが gh CLI / SSH 鍵で設定する前提です

<br>

## 複数マシンでの運用例

claude-brain は Git 同期により**複数マシンで 1 つの Wiki を共有**できるよう設計されています。
作者は MacBook（メイン開発機）と Mac mini（Claude Code の bypass permission 用）の 2 台構成で運用しています。

この構成のポイント:
- **`session-logs/` はマシンごとにローカル保持**（`.gitignore` 対象）。各マシンのセッションログは独立しており、Git には push されません
- **`wiki/` は Git 同期**。どちらのマシンの Ingest 結果も同じ Wiki に蓄積されます
- **Ingest / Lint の実行時刻をずらす**ことで、git push の競合を回避しています
- SessionEnd Hook の自動 commit/push は両マシンで有効ですが、通常のコーディングセッションでは `session-logs/` への書き込みのみで Git 操作は発生しません（wiki/ を直接変更した場合のみ push されます）

参考: 作者の 2 台構成

| | MacBook（メイン） | Mac mini（bypass 用） |
|---|---|---|
| 秘匿情報 | あり | なし |
| `session-logs/` | ローカルのみ | ローカルのみ |
| `wiki/` | Git 同期 | Git 同期 |
| Ingest 時刻 | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint 時刻 | 毎月 1 日 8:00 | 毎月 2 日 8:00 |
| 定期実行方式 | LaunchAgent | LaunchAgent |

> 1 台だけで運用する場合はこのセクションを気にする必要はありません。クイックスタートの手順だけで完結します。

<br>

## セキュリティ

claude-brain は Claude Code の**全セッション入出力にアクセスする Hook システム**です。
セキュリティ設計の詳細は [SECURITY.md](SECURITY.md) を参照してください。

### 機密保護の仕組み

| 層 | 内容 |
|---|---|
| **入力バリデーション** | `OBSIDIAN_VAULT` パスにシェルメタ文字・JSON/XML 制御文字が含まれていないか検証 |
| **マスキング** | API キー（Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe）、Bearer/Basic 認証、URL 埋込クレデンシャル、PEM 秘密鍵を正規表現で `***` に置換 |
| **パーミッション** | `session-logs/` は `0o700`、ログファイルは `0o600` で作成。Hook スクリプトは `chmod 755` |
| **.gitignore ガード** | SessionEnd の git commit 前に `.gitignore` に `session-logs/` が含まれていることを検証 |
| **再帰防止** | `KIOKU_NO_LOG=1` + cwd-in-vault チェックの二重ガードでサブプロセスの再帰ログを防止 |
| **LLM 権限制限** | auto-ingest / auto-lint の `claude -p` は `--allowedTools Write,Read,Edit`（Bash なし）で実行 |
| **定期スキャン** | `scan-secrets.sh` が月次で session-logs/ を既知のトークンパターンでスキャンし、マスキング漏れを検知 |

### マスキング対象トークン

新しいクラウドサービスのトークンを扱い始めた場合、`hooks/session-logger.mjs` の `MASK_RULES` と `scripts/scan-secrets.sh` の `PATTERNS` に対応するパターンを追加してください。

### 脆弱性の報告

セキュリティの問題を見つけた場合は、公開 Issue ではなく [SECURITY.md](SECURITY.md) に記載の方法で報告してください。

<br>

## 今後の実装予定

### 直近
- [ ] **Ingest 選別品質のチューニング** — 2 週間の実運用後に Vault CLAUDE.md の選別基準を調整
- [ ] **qmd 多言語検索精度の検証** — 日本語コンテンツのセマンティック検索精度を確認、必要に応じて埋め込みモデルを差し替え（`multilingual-e5-small` 等）
- [ ] **安全な自動修正スキル (`/wiki-fix-safe`)** — Lint の軽微な問題（相互リンク追加、フロントマター補完）を人間の承認付きで自動修正
- [ ] **Git 同期エラーの可視化** — `git push` の失敗を `session-logs/.claude-brain/git-sync.log` に記録し、auto-ingest で警告表示

### 中期
- [ ] **マルチ LLM 対応** — auto-ingest/lint の `claude -p` をプラガブルな LLM バックエンドに置き換え（OpenAI API、Ollama 経由のローカルモデル等）
- [ ] **CI/CD** — push 時の自動テスト（GitHub Actions）
- [ ] **Lint 差分通知** — 前回のレポートとの差分を取り、新規検出された問題のみを通知
- [ ] **index.json の楽観的ロック** — 複数の Claude Code セッションが並行動作する際の更新消失を防止

### 長期
- [ ] **Morning Briefing** — 毎朝の日次サマリーを自動生成（昨日のセッション要約、未完了の設計判断、新しい知見のハイライト）→ `wiki/daily/YYYY-MM-DD.md`
- [ ] **プロジェクト別コンテキスト注入** — `cwd` からプロジェクトを推定し、`wiki/index.md` の注入内容をフィルタリング（10,000 文字上限対策）
- [ ] **技術スタック推奨スキル (`/wiki-suggest-stack`)** — 蓄積された Wiki 知識に基づいて新プロジェクトの技術スタックを提案
- [ ] **チーム共有 Wiki** — 複数人での Wiki 共有（各メンバーの session-logs はローカル保持、wiki/ のみ Git で共有）

> **注意**: claude-brain は現在 **Claude Code（Max プラン）** が必要です。Hook システム (L0) と Wiki コンテキスト注入は Claude Code 固有の機能です。Ingest/Lint パイプライン (L1/L2) は `claude -p` の呼び出しを差し替えることで他の LLM API でも動作可能 — これは将来の拡張として計画中です。

<br>

## 更新履歴

### 2026-04-24 — v0.6.0: エコシステム拡張 — マルチエージェント + plugin marketplace + Bases dashboard + delta tracking + セキュリティ強化

v0.6.0 は Phase C を一気に land: 配布チャネル拡大 (Claude Code plugin + multi-agent skills)、Obsidian 標準ダッシュボード、silent regression 防御 ingest、security policy 強化。Visualizer の土台 (v0.7 α 向け) も同時投入。

- **マルチエージェント cross-platform (C-1)** — `scripts/setup-multi-agent.sh` で Codex CLI / OpenCode / Gemini CLI に KIOKU skills を symlink 配置。19/19 Bash アサーション (SMA-1..8)
- **Claude Code plugin marketplace (C-2)** — `claude marketplace add megaphone-tokyo/kioku && claude plugin install kioku@megaphone-tokyo` で install 可能。`docs/install-guide-plugin.md` で 3 install 方法比較
- **Raw MD sha256 delta tracking (C-3)** — user が `raw-sources/<subdir>/*.md` に直接配置した MD も sha256 delta 検出対象に。82/82 auto-ingest assertions (新規 F23-F27)
- **Obsidian Bases dashboard (C-4)** — `templates/wiki/meta/dashboard.base` に KIOKU wiki 構造に合わせた 9 view (Hot Cache / Active Projects / Recent Activity / Concepts / Design Decisions / Analyses / Patterns / Bugs / Stale Pages)
- **Visualizer 土台 (V-1、v0.7 α 準備)** — `mcp/lib/git-history.mjs` + `mcp/lib/wiki-snapshot.mjs`、14/14 Node アサーション。user 可視効果はまだなし
- **Security policy 強化 (C-5a)** — `SECURITY.md` に CVE Classification / Safe Harbor / Coordinated Disclosure Timeline / Out of Scope を追加。`SECURITY.ja.md` は 4/7 section 日本語化完了
- **Community channel 方針転換** — 専用 Discord は不採用、GitHub Discussions に集約
- **組織知** — **LEARN#10** (PM handoff 作成時の script line verify 必須化) を組織知化
- **v0.7+ へ defer** — Visualizer HTML UI (V-2〜V-5)、LP β narrative、GitHub Discussions 有効化、SECURITY.ja 残 3 section
- テスト: **Node 264/264 + Bash 400+/400+ assertions green** 全 regression suite
- [Release v0.6.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.6.0) — `kioku-wiki-0.6.0.mcpb` 添付 (~9 MB)

### 2026-04-23 — v0.5.1: ホットキャッシュ + PostCompact hook + opt-in Stop prompt

- **ホットキャッシュ pattern** — 新しい `wiki/hot.md` (500 word 以下、hard cap 4000 文字) が **SessionStart** 時に自動注入され、**PostCompact** (context 圧縮) 後にも再注入される。LLM が session 間 / compaction 跨ぎで短期作業 context を保持できるようになった。claude-obsidian の UX pattern を参考に導入
- **PostCompact hook** — `install-hooks.sh` に 6 番目の event (`PostCompact`) を追加。compaction 後は hot.md のみ再注入 (index.md は既に context に残存するため token 節約のため skip)
- **Opt-in Stop prompt** (`KIOKU_HOT_AUTO_PROMPT=1`) — 明示的に set した場合のみ、session 終了時に hot.md 更新提案 prompt が出る。**default OFF** — hot.md は Git sync 対象で session-logs より厳しい security boundary を持つため、自動 prompt は user の明示同意を必要とする
- **Security boundary 維持** — hot.md は注入前に `applyMasks()` (API key / token パターン伏字化) を通し、scan-secrets.sh の走査対象に含まれ、`realpath` で symlink escape (vault 外パス) を拒否、4000 文字で truncate + WARN log
- **Claude Code v2 hook schema 対応 (4 hotfix)** — Claude Code v2 は event ごとに異なる output schema を要求する: `hookSpecificOutput` は `PreToolUse` / `UserPromptSubmit` / `PostToolUse` のみサポート、`PostCompact` / `Stop` は top-level `systemMessage` を使う必要がある。旧 v1 flat `{additionalContext}` は v2 で silent 無効化される。hotfix 1-4 で全 hook output を per-event で正しい schema に移行
- テスト: **Node 47 件** (HOT-1..9d + HOT-V1/V2 + session-logger regression + injector H1-H5) **+ Bash 488 assertions** (IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 既存 15 suites)、全 green
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` 添付 (9.2 MB)

### 2026-04-23 — v0.5.0: 機能 2.4 — PDF / MD / EPUB / DOCX 統一 ingest router

- **Phase 1** — `kioku_ingest_document` router を追加。拡張子 (`.pdf` / `.md` / `.epub` / `.docx`) で適切な handler に dispatch する統一 MCP tool。従来の `kioku_ingest_pdf` は deprecation alias として v0.5 〜 v0.7 window で残留、v0.8 で削除予定
- **Phase 2** — EPUB 取り込み: yauzl ベースの 8 層防御 (zip-slip / symlink / 累積 size cap / entry count cap / NFKC filename / nested ZIP skip / XXE pre-scan / XHTML script sanitize) で安全に展開。spine 順の章を `readability-extract` + `turndown` で Markdown chunk 化し、`.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md` に保存 (2 章以上なら `-index.md` も生成)。LLM 要約は auto-ingest cron で非同期処理
- **Phase 3** — DOCX 取り込み (MVP): `mammoth + yauzl` の 2 段構え (mammoth 内部 jszip の attack surface を yauzl 側の 8 層で事前防御)。`word/document.xml` / `docProps/core.xml` は XXE pre-scan (`assertNoDoctype`) 経由。画像 (VULN-D004/D007) と OLE 埋め込み (VULN-D006) は defer、MVP では本文 + 見出しのみ抽出。Metadata は `--- DOCX METADATA ---` fence + **untrusted** 注釈で下流 LLM 要約への prompt injection を delimit
- **Pre-release hotfix** — `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` の argv 正規表現を Unicode-aware (`\p{L}\p{N}`) に修正。旧 `\w` (ASCII のみ) では `論文.docx` / `日本語.epub` 等の日本語/中国語ファイル名が auto-ingest cron の経路で silent skip されていた。EPUB は v0.4.0 以降の latent regression を遡及修正 (LEARN#6 cross-boundary drift)。併せて `html-sanitize` の `DANGEROUS_TAGS` に `meta` / `base` / `link` を追加 (将来の EPUB consumer 経路向け defense-in-depth)
- **既知 issue (非適用)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6)、medium) は **XMLBuilder** (XML を書く API) 固有の問題。本プロジェクトは `mcp/lib/xml-safe.mjs` で **XMLParser のみ** (XML を読む API) を使用しているため exploit 不可。dependabot alert 解消のため **v0.5.1** で `fast-xml-parser@^5.7.0` へ upgrade 予定
- テスト: **Bash 158 assertions + Node 全 suite green** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30)。`npm audit` は runtime deps で **0 vulnerabilities**、red-hacker + blue-hacker 並列 `/security-review` で **HIGH/CRITICAL 0**
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` 添付 (9.2 MB)

### 2026-04-21 — v0.4.0: Tier A (security + ops) + Tier B (cleanness) 全面レビュー

- **A#1** — `@mozilla/readability` を 0.5 → 0.6 にアップグレード、ReDoS ([GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7)) を完全解消。production deps 144 パッケージが `npm audit` clean を確認
- **A#2** — `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd の git 処理に `git symbolic-ref -q HEAD` ガードを追加。Vault が detached-HEAD 状態にある時の暴走 commit を防止 (修正前に 1 台で 5 日間の drift を実観測)
- **A#3** — `withLock` をリファクタ (保持時間を数分 → 数秒に短縮)、`skipLock` API を全削除、orphan-PDF のクリーンアップも追加
- **B#1** — Hook 層 re-audit (`session-logger.mjs`) で MEDIUM × 3 を修正 (不可視文字による mask バイパス / frontmatter への YAML injection / `KIOKU_NO_LOG` の strict-equality drift)
- **B#2** — cron/setup 層の env-override ガード整合性を `tests/cron-guard-parity.test.sh` (17 assertions) として enforcement 化。Category A / Category B 規約の drift を再発防止
- **B#3** — `sync-to-app.sh` の cross-machine race を `check_github_side_lock` (α guard) で予防。閾値 120 秒 (`KIOKU_SYNC_LOCK_MAX_AGE` で調整可)、回帰は `tests/sync-to-app.test.sh` (11 assertions) で固定化
- **B#8** — README i18n parity: §10 MCP / §11 MCPB / 更新履歴セクションを en/ja 以外の 8 言語 README に展開 (+1384 行)
- テスト: **Node 299 tests** + **Bash 15 suites / 415 assertions** 全 green
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` 添付

### 2026-04-17 — Phase N: Claude Desktop 向け MCPB バンドル
- `mcp/manifest.json` (MCPB v0.4) と `scripts/build-mcpb.sh` を追加し、`mcp/dist/kioku-wiki-<version>.mcpb` (約 3.2 MB) を生成可能に
- Claude Desktop ユーザーは `.mcpb` ファイルを 1 つドラッグするだけでインストール完了。`OBSIDIAN_VAULT` はインストールダイアログの directory picker で選択 (ユーザー側に Node のインストール不要 — Desktop の同梱ランタイムが利用される)
- Phase M の手動インストール経路 (`setup-mcp.sh` + `install-mcp-client.sh`) はそのまま残る。MCPB は Desktop 中心ユーザー向けの追加チャンネル
- ビルドとインストール手順は **§ 11** を参照

### 2026-04-17 — Phase M: kioku-wiki MCP サーバー
- ローカル stdio MCP サーバー (`tools/claude-brain/mcp/`)。6 ツール提供 — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Claude Desktop と Claude Code の両方から、チャットを離れずに Wiki の検索・読み取り・書き込みが可能に
- セットアップ手順は **§ 10** を参照

### 2026-04-16 — Phase L: macOS LaunchAgent への移行
- 新スクリプト `scripts/install-schedule.sh` が macOS LaunchAgent / Linux cron を OS 自動判別で配置
- macOS の cron がユーザーの完全な PATH を読み込めないという構造的不可能性を解消

<br>

## License

本プロジェクトは MIT License のもとで公開されています。詳細は [LICENSE](../../LICENSE) をご覧ください。

なお、冒頭の「注意事項」にも記載の通り、本ソフトウェアは「現状のまま」提供され、いかなる保証もありません。

<br>

## 参考

- [Karpathy の LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 本プロジェクトが実装する元のコンセプト
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Hook システムの公式ドキュメント
- [Obsidian](https://obsidian.md/) — Wiki ビューアとして使用するナレッジ管理アプリ
- [qmd](https://github.com/tobi/qmd) — Markdown 用ローカル検索エンジン（BM25 + ベクトル検索）

<br>

## 作者

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

コードと AI で何かつくる人 / フリーランスエンジニア 10 年目 / フロントエンド中心、最近は Claude との共同開発がメイン

[よかったらフォローしてください](https://x.com/megaphone_tokyo)
