---
name: setup-guide
description: "claude-brain の対話式セットアップガイド。`/setup-guide` で起動。各ステップの意味と意図を説明しながら、ユーザーの環境に合わせてインストール作業を順番に進める。初めてのユーザーでも迷わないように設計。"
---

# claude-brain セットアップガイド

claude-brain のインストールを**対話形式**で順番に進めるスキル。
各ステップで「何をするのか」「なぜ必要なのか」を説明し、ユーザーの入力を待ってから次に進む。

## 進め方

- ユーザーの環境（OS、Node バージョン管理ツール、既存の Vault の有無）を最初にヒアリングする
- 各ステップはユーザーの「できた」「次へ」等の確認を待ってから進む
- エラーが出た場合はトラブルシューティングを行う
- スキップ可能なステップは明示する

## ステップ一覧

### Step 0: 環境確認

以下をユーザーにヒアリングまたは自動検出する:

1. **OS**: macOS / Linux / WSL のどれか
2. **Node.js**: `node --version` を実行して 18+ か確認。未インストールならインストール案内
3. **Git**: `git --version` を確認
4. **jq**: `jq --version` を確認。なければ `brew install jq` 等を案内
5. **Claude Code**: `claude --version` を確認。Max プランかどうかはユーザーに聞く
6. **Obsidian**: インストール済みかユーザーに聞く（コマンドでは確認できない）
7. **Node バージョン管理ツール**: Volta / mise / nvm / fnm / asdf / なし のどれか

結果をまとめて表示し、問題があれば解決してから次に進む。

```
✅ macOS 15.2
✅ Node.js v22.0.0 (Volta)
✅ Git 2.44.0
✅ jq 1.7.1
✅ Claude Code 1.x (Max プラン)
⚠️ Obsidian 未確認 → https://obsidian.md/ からインストールしてください
```

### Step 1: Vault の作成と Git 接続 (ユーザー作業)

**何をするか**: Obsidian で新しい Vault を作り、GitHub Private リポジトリと接続する。

**なぜ必要か**: claude-brain は Obsidian Vault の中にセッションログと Wiki を保存する。Git で管理することで、複数マシン間の同期とバックアップが自動化される。

**手順**:
1. Obsidian を開き「Create new vault」を選択
   - 名前: `main-claude-brain`（任意）
   - 場所: `~/claude-brain/`（推奨。`~/Documents/` は macOS の TCC でバックグラウンドアクセスがブロックされるため避ける）
2. GitHub で Private リポジトリを作成
3. Vault ディレクトリで Git を初期化

ユーザーの GitHub CLI の有無に応じてコマンドを出し分ける:

```bash
# gh CLI がある場合（簡単）
cd ~/claude-brain/main-claude-brain
gh repo create claude-brain --private --source=. --push

# gh CLI がない場合（手動）
cd ~/claude-brain/main-claude-brain
git init
git remote add origin git@github.com:<USERNAME>/claude-brain.git
git add -A && git commit -m "initial" && git push -u origin main
```

**確認**: `git remote -v` で origin が設定されていることを確認する。

### Step 2: 環境変数の設定

**何をするか**: `OBSIDIAN_VAULT` 環境変数に Vault のパスを設定する。

**なぜ必要か**: claude-brain の全スクリプトがこの変数を参照して Vault の場所を知る。Hook スクリプトも Claude Code から実行される際にこの変数を使う。

**手順**: ユーザーのシェル（zsh / bash）を検出して適切なファイルに追記する。

```bash
# ~/.zshrc（macOS のデフォルト）または ~/.bashrc に追記
echo 'export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"' >> ~/.zshrc
source ~/.zshrc
```

**確認**: `echo $OBSIDIAN_VAULT` で正しいパスが表示されることを確認。

### Step 3: Vault の初期化

**何をするか**: Vault 内にディレクトリ構造（`session-logs/`, `wiki/`, `raw-sources/` 等）と初期ファイル（`CLAUDE.md`, `.gitignore`, テンプレート）を配置する。

**なぜ必要か**: claude-brain の Hook とスクリプトは特定のディレクトリ構成を前提に動作する。`.gitignore` は `session-logs/`（機密データを含む）を Git から除外するために必須。

**手順**:

```bash
bash tools/claude-brain/scripts/setup-vault.sh
```

**確認**: `ls $OBSIDIAN_VAULT` でディレクトリ構造を確認。

### Step 4: Hook のインストール

**何をするか**: Claude Code の `~/.claude/settings.json` に Hook 設定を追加する。

**なぜ必要か**: Hook が Claude Code のイベント（ユーザーの入力、AI の応答、ツール使用、セッション終了）を捕捉してセッションログに記録する。これが claude-brain の自動記録の核心。

**手順**:

```bash
# 自動マージ（推奨）
bash tools/claude-brain/scripts/install-hooks.sh --apply

# diff が表示される。内容を確認して y で適用
```

**このコマンドが行うこと**:
- 既存の `~/.claude/settings.json` のバックアップを作成
- claude-brain の Hook エントリを既存設定にマージ（既存設定は上書きしない）
- diff を表示して確認を求める

**確認**: Claude Code を再起動し、何か 1 つ会話をして、`ls $OBSIDIAN_VAULT/session-logs/` にファイルが生成されることを確認。

---

**ここまでが必須ステップです。** 以下は任意ですが、推奨です。

---

### Step 5: 定期実行のセットアップ (推奨)

**何をするか**: セッションログを Wiki に取り込む定期ジョブ（Ingest: 毎日）と、Wiki の健全性チェック（Lint: 毎月）を設定する。

**なぜ必要か**: 手動で Ingest を実行しなくても、毎日自動的にセッションの知見が Wiki に蓄積される。Lint は Wiki の品質を維持する。

**手順**:

```bash
# まず DRY RUN で動作確認（実際には何もしない）
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh

# 問題なければ定期実行を設定
bash tools/claude-brain/scripts/install-schedule.sh
```

**OS に応じた動作**:
- macOS: LaunchAgent が `~/Library/LaunchAgents/` に配置される
- Linux: cron エントリが出力される（手動で `crontab -e` に追記）

Step 0 で検出した Node バージョン管理ツールが Volta / mise 以外の場合は、`auto-ingest.sh` と `auto-lint.sh` の PATH 設定を案内する。

### Step 6: qmd 検索エンジン (任意)

**何をするか**: Wiki を MCP 経由で全文検索・セマンティック検索できるようにする。

**なぜ必要か**: Wiki が大きくなると index.md だけでは探しきれない。qmd は BM25 + ベクトル検索で関連ページを高精度に見つける。

**前提**: `npm install -g @tobilu/qmd` が必要。

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

### Step 7: Wiki Ingest スキル (任意)

**何をするか**: `/wiki-ingest-all` と `/wiki-ingest` スラッシュコマンドを使えるようにする。

**なぜ必要か**: 既存プロジェクトの知識を一括で Wiki に取り込める。

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

### 完了

セットアップ完了後、以下のまとめを表示する:

```
🎉 claude-brain のセットアップが完了しました！

✅ Vault: $OBSIDIAN_VAULT
✅ Hook: ~/.claude/settings.json に設定済み
✅ 定期実行: [LaunchAgent / cron / 未設定]
✅ qmd: [設定済み / 未設定]
✅ Wiki Ingest スキル: [設定済み / 未設定]

次にやること:
1. Claude Code を再起動する
2. いつも通りコーディングする（自動で記録されます）
3. 翌日、Obsidian で wiki/ を開いて知識が蓄積されているか確認する
```
