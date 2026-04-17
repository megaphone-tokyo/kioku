## マニュアルは多言語化されています

> [!NOTE]
> **🌐 他の言語:** [🇬🇧 English](README.md) · 🇯🇵 **日本語** · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
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
> KIOKU は現在 **Claude Code（Max プラン）** が必要です。Hook システム (L0) と Wiki コンテキスト注入は Claude Code 固有の機能です。Ingest/Lint パイプライン (L1/L2) は `claude -p` の呼び出しを差し替えることで他の LLM API でも動作可能 — これは将来の拡張として計画中です。

> [!IMPORTANT]
> 本ソフトウェアは **「現状のまま」** 提供されます。いかなる種類の保証もありません。作者は、本ツールの使用によって生じた**データの損失、セキュリティインシデント、その他の損害について一切の責任を負いません**。自己責任でご使用ください。詳細は [LICENSE](LICENSE) をご確認ください。

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
| 環境変数 | `OBSIDIAN_VAULT` で Vault ルートを指定 |

<br>

## クイックスタート

> [!WARNING]
> **インストール前にご理解ください:** KIOKU は Claude Code の**全セッション入出力**にフックします。これは以下を意味します:
> - セッションログにプロンプトやツール出力の **API キー、トークン、個人情報** が含まれる可能性があります。マスキングは主要なパターンをカバーしますが完全ではありません — [SECURITY.md](SECURITY.md) を確認してください
> - `.gitignore` の設定が壊れると、セッションログが **誤って GitHub に push される** 可能性があります
> - auto-ingest パイプラインはセッションログの内容を `claude -p` 経由で Claude に送信し、Wiki の知識を抽出します
>
> まず `KIOKU_DRY_RUN=1` でパイプラインを確認してから本番運用を開始することを推奨します。

### 🚀 対話式セットアップ (推奨)

> [!NOTE]
>Claude Code で以下を入力すると、対話形式でセットアップを進められます。各ステップの意味と意図を説明しながら、あなたの環境に合わせてガイドします。

```
skills/setup-guide/SKILL.md を参照して、KIOKU のインストール作業をしてください。
```

### 🛠️ マニュアルセットアップ

> [!NOTE]
> 各ステップを自分で理解しながら進めたい方向け。スクリプトを直接実行していきます。

#### 1. Vault を作成し Git リポジトリと接続する（ユーザー作業）

1. Obsidian で新規 Vault を作成（例: `~/kioku/main-kioku`）
2. GitHub で Private リポジトリを作成（例: `kioku`）
3. Vault ディレクトリで `git init && git remote add origin ...` を行う（or `gh repo create --private --source=. --push`）

この手順は KIOKU のスクリプトでは自動化しません。GitHub 認証（gh CLI / SSH 鍵）はユーザー環境に依存するため、責任境界を分けています。

#### 2. 環境変数を設定

```bash
# ~/.zshrc に追記
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Vault の初期化

```bash
# Vault 配下に raw-sources/, session-logs/, wiki/, templates/ を作り、
# CLAUDE.md / .gitignore / 初期テンプレートを配置する（既存ファイルは上書きしない）
bash scripts/setup-vault.sh
```

#### 4. Hook のインストール

```bash
# 方法 A: 自動マージ（推奨。jq が必要）
bash scripts/install-hooks.sh --apply
# バックアップ作成 → diff 表示 → 確認プロンプト → 既存設定を保持したまま Hook エントリを追加

# 方法 B: 手動マージ
bash scripts/install-hooks.sh
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
bash scripts/install-schedule.sh

# まず DRY RUN で経路を確認
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **macOS の注意**: `~/Documents/` や `~/Desktop/` 配下にリポを置くと TCC (Transparency, Consent, Control) が
> バックグラウンドアクセスをブロックし EPERM になります。`~/_PROJECT/` など保護対象外のパスを推奨します。

手動で 1 回だけ取り込みたい場合は、スクリプトを直接叩けば同じ処理が走ります。

#### 7. qmd 検索エンジンのセットアップ（任意）

Wiki を MCP 経由で全文検索・セマンティック検索できるようにします。

```bash
# qmd コレクション登録 + 初回インデックス
bash scripts/setup-qmd.sh

# qmd MCP HTTP サーバーを launchd 常駐（macOS のみ）
bash scripts/install-qmd-daemon.sh
```

#### 8. Wiki Ingest スキルの配置（任意）

`/wiki-ingest-all`（既存プロジェクト一括取り込み）と `/wiki-ingest`（ターゲットスキャン）を使えるようにします。

```bash
# ~/.claude/skills/ に symlink を配置
bash scripts/install-skills.sh
```

#### 9. Mac mini などの追加マシンへの展開

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Obsidian で ~/kioku/main-kioku/ を Vault として開く
# 上記の 2〜6 の手順を繰り返す
```

#### 10. Claude Desktop / Code から Wiki に到達する MCP サーバー (任意)

Claude Desktop には Hook システムがないため、自動では Wiki に何も保存されません。
代わりに **`kioku-wiki` MCP サーバー** を立てておくと、Claude Desktop と Claude Code の両方から Wiki の検索・読み取り・書き込みができます。

```bash
# 1. 依存セットアップ (mcp/ 配下にだけ npm install)
bash scripts/setup-mcp.sh

# 2. 接続確認 (Inspector でブラウザから疎通確認)
npx @modelcontextprotocol/inspector node mcp/server.mjs

# 3. クライアント登録 (まずはプレビュー)
bash scripts/install-mcp-client.sh --dry-run

# 4. 問題なければ反映
bash scripts/install-mcp-client.sh --apply

# 5. Claude Code (CLI / VSCode) には別途登録 (上記 stdio コマンドで案内される)
claude mcp add --scope user --transport stdio kioku \
  "$(command -v node)" "$(pwd)/mcp/server.mjs"
```

提供される 6 ツール:

| ツール | 用途 |
|---|---|
| `kioku_search` | Wiki 全文検索 (qmd 委譲、qmd 不在時は Node 簡易 grep) |
| `kioku_read` | wiki/<path>.md の内容を返す |
| `kioku_list` | wiki/ ディレクトリツリー |
| `kioku_write_note` (推奨) | session-logs/ にメモを書き出し、次回 auto-ingest が wiki/ に構造化 |
| `kioku_write_wiki` (上級) | wiki/ への即時直書き (テンプレ準拠、frontmatter 自動付与) |
| `kioku_delete` | wiki/.archive/ への移動 (復元可能、index.md 不可) |

**ポイント**:
- 完全ローカル (stdio、ネットワーク非露出、`@modelcontextprotocol/sdk` のみ依存)
- Desktop からの「保存して」指示は **`kioku_write_note` を優先**。整合性が保たれる
- 即時反映が必要な時だけ `kioku_write_wiki`
- 既存の qmd MCP (HTTP :8181) と共存。検索は qmd MCP の `search` を優先 (kioku_search はフォールバック)

アンインストール:

```bash
bash scripts/install-mcp-client.sh --uninstall
rm -rf mcp/node_modules
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
bash scripts/build-mcpb.sh

# 2. (任意) manifest 検証 + アーカイブ中身の確認
bash scripts/build-mcpb.sh --validate
npx --yes @anthropic-ai/mcpb info mcp/dist/kioku-wiki-0.1.0.mcpb

# 3. ビルド成果物の掃除
bash scripts/build-mcpb.sh --clean
```

バンドルは **gitignore 対象** (`mcp/build/`, `mcp/dist/`)。新リリース公開時は `build-mcpb.sh` でビルドし、生成された `.mcpb` を新しい [GitHub Release](https://github.com/megaphone-tokyo/kioku/releases) に添付してください。エンドユーザーは Option A 経由でダウンロードできます。

手順 10 の従来のインストール経路もそのまま使えます。MCPB は Desktop 中心ユーザー向けの**追加チャンネル**であり、置き換えではありません。

<br>

## ディレクトリ構成

```

├── README.md                        ← 本ファイル
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
| `OBSIDIAN_VAULT` | なし (必須) | Vault ルート。auto-ingest/lint のみ `${HOME}/kioku/main-kioku` をデフォルトとしてフォールバック |
| `KIOKU_DRY_RUN` | `0` | `1` にすると auto-ingest/lint が `claude -p` を呼ばず経路確認だけする |
| `KIOKU_NO_LOG` | 未設定 | `1` にすると `session-logger.mjs` が早期 return。cron サブプロセスの再帰ログ防止用 |
| `KIOKU_DEBUG` | 未設定 | `1` にすると stderr と `session-logs/.kioku/errors.log` にデバッグ情報を出す |
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

KIOKU は Git 同期により**複数マシンで 1 つの Wiki を共有**できるよう設計されています。
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

KIOKU は Claude Code の**全セッション入出力にアクセスする Hook システム**です。
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
- [ ] **Git 同期エラーの可視化** — `git push` の失敗を `session-logs/.kioku/git-sync.log` に記録し、auto-ingest で警告表示

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

> **注意**: KIOKU は現在 **Claude Code（Max プラン）** が必要です。Hook システム (L0) と Wiki コンテキスト注入は Claude Code 固有の機能です。Ingest/Lint パイプライン (L1/L2) は `claude -p` の呼び出しを差し替えることで他の LLM API でも動作可能 — これは将来の拡張として計画中です。

<br>

## 更新履歴

### 2026-04-17 — Phase N: Claude Desktop 向け MCPB バンドル
- `mcp/manifest.json` (MCPB v0.4) と `scripts/build-mcpb.sh` を追加し、`kioku-wiki-<version>.mcpb` (約 3.2 MB) を生成可能に
- Claude Desktop ユーザーは `.mcpb` ファイルを 1 つドラッグするだけでインストール完了。`OBSIDIAN_VAULT` はインストールダイアログの directory picker で選択 (ユーザー側に Node のインストール不要 — Desktop の同梱ランタイムが利用される)
- ビルドとインストール手順は **§ 11** を参照

### 2026-04-17 — Phase M: kioku-wiki MCP サーバー
- ローカル stdio MCP サーバー (`mcp/`)。6 ツール提供 — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Claude Desktop と Claude Code の両方から、チャットを離れずに Wiki の検索・読み取り・書き込みが可能に
- セットアップ手順は **§ 10** を参照

### 2026-04-16 — Phase L: macOS LaunchAgent への移行
- 新スクリプト `scripts/install-schedule.sh` が macOS LaunchAgent / Linux cron を OS 自動判別で配置
- macOS の cron がユーザーの完全な PATH を読み込めないという構造的不可能性を解消

<br>

## License

本プロジェクトは MIT License のもとで公開されています。詳細は [LICENSE](LICENSE) をご覧ください。

なお、冒頭の「注意事項」にも記載の通り、本ソフトウェアは「現状のまま」提供され、いかなる保証もありません。

<br>

## 参考

- [Karpathy の LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 本プロジェクトが実装する元のコンセプト
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Hook システムの公式ドキュメント
- [Obsidian](https://obsidian.md/) — Wiki ビューアとして使用するナレッジ管理アプリ
- [qmd](https://github.com/tobi/qmd) — Markdown 用ローカル検索エンジン（BM25 + ベクトル検索）

<br>

## Other Products

[こんにちは、季節より。](https://hello-from.dokokano.photo/)

<br>

## 作者

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

コードと AI で何かつくる人 / フリーランスエンジニア 10 年目 / フロントエンド中心、最近は Claude との共同開発がメイン

[よかったらフォローしてください](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
