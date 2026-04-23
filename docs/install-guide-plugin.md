---
title: Install KIOKU as a Claude Code Plugin
updated: 2026-04-23
---

# KIOKU as a Claude Code Plugin

KIOKU は 3 つのインストール方法があります:

| 方法 | 用途 | 対象 |
|---|---|---|
| **1. `.mcpb` bundle** | Claude Desktop / Claude Code (GUI) への drag & drop | エンドユーザー、最速 |
| **2. Claude Code plugin (本書)** | `claude plugin install` コマンドで install / update | 開発者、version 管理重視 |
| **3. Manual setup** | parent repo を clone + `install-hooks.sh` | contributor、カスタマイズ運用 |

本書は **方法 2 (plugin install)** をガイドします。方法 1 は [README](../README.md) を、方法 3 は [app/README.md](../app/README.md) #Quick-Start を参照。

## 前提

- Claude Code (Max plan) インストール済
- `claude` CLI が PATH に通っている (`claude --version` で確認)
- Obsidian Vault を 1 つ用意 (どのフォルダでもよい、iCloud Drive は不要)

## 方法 A: marketplace 経由でインストール

```bash
# 1. marketplace を登録 (初回のみ)
claude marketplace add megaphone-tokyo/kioku

# 2. plugin install
claude plugin install kioku@megaphone-tokyo

# 3. 動作確認
claude plugin list | grep kioku
# => kioku  0.5.1  (installed)
```

## 方法 B: 直接 repo を指定してインストール

```bash
claude plugin install github:megaphone-tokyo/kioku
```

## Post-install 手順

plugin install は **skills / hooks / scripts を Claude Code の discover path に配置** するだけで、Vault 初期化までは自動化されません。以下を追加実行してください:

### 1. 環境変数を設定

```bash
# ~/.zshrc (macOS zsh) or ~/.bashrc (Linux bash) に追加
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

### 2. Vault の初期化

```bash
# 新規 Vault の場合のみ
mkdir -p "$OBSIDIAN_VAULT"
cd "$OBSIDIAN_VAULT" && git init
gh repo create --private --source=. --push  # GitHub Private repo を作成

# KIOKU の Vault 構造を展開 (冪等、既存ファイルは上書きしない)
bash ~/.claude/plugins/kioku/scripts/setup-vault.sh
```

### 3. Hook を `~/.claude/settings.json` にマージ

```bash
bash ~/.claude/plugins/kioku/scripts/install-hooks.sh --apply
# バックアップ作成 → diff 表示 → 確認プロンプト → 既存設定を保持して Hook 追加
```

### 4. LaunchAgent / cron で定期 Ingest (任意)

```bash
# OS 自動判別 (macOS → LaunchAgent / Linux → cron)
bash ~/.claude/plugins/kioku/scripts/install-schedule.sh
```

### 5. MCP server を Claude Desktop に登録 (任意、全 Claude Code skills + Desktop 両方で使う場合)

```bash
# 依存セットアップ
bash ~/.claude/plugins/kioku/scripts/setup-mcp.sh

# Claude Desktop に登録
bash ~/.claude/plugins/kioku/scripts/install-mcp-client.sh --apply
```

## 動作確認

Claude Code を再起動してから、会話を 1 つ発生させる:

```bash
# KIOKU 管理下の Vault に session log が出るはず
ls "$OBSIDIAN_VAULT/session-logs/" | tail -1
# => 20260423-170000-xxxx-<最初のプロンプト>.md が最新
```

Hot cache 機能の確認 (v0.5.1 以降):

```bash
# 新規セッションで、hot.md を自動注入されていることを verify
cat "$OBSIDIAN_VAULT/wiki/hot.md"
# => frontmatter + "## Recent Context" が入っている

# context compaction (`/compact` で手動発火) 後、再注入されるか
# KIOKU_DEBUG=1 で stderr にサイズ log が出る
export KIOKU_DEBUG=1
```

## Upgrade

```bash
claude plugin upgrade kioku
```

KIOKU は SemVer を守ります。major bump (0.x → 1.0) で breaking change が起きる場合は Release note に `BREAKING:` を明記します。

## Uninstall

```bash
# 1. plugin を削除
claude plugin uninstall kioku

# 2. Hook 設定を手動で削除
# ~/.claude/settings.json から KIOKU 関連の hook entry を削除
# (install-hooks.sh の backup が ~/.claude/settings.json.backup.<timestamp> にあるので復元可能)

# 3. LaunchAgent (macOS の場合)
launchctl unload ~/Library/LaunchAgents/com.kioku.ingest.plist
launchctl unload ~/Library/LaunchAgents/com.kioku.lint.plist
rm ~/Library/LaunchAgents/com.kioku.*.plist

# 4. (任意) Vault を削除
# rm -rf "$OBSIDIAN_VAULT"  # 注意: knowledge base も消える
```

## トラブルシューティング

| 症状 | 原因 | 解決 |
|---|---|---|
| `claude plugin install` で not found | marketplace 未登録 | `claude marketplace add megaphone-tokyo/kioku` を先に実行 |
| session log が生成されない | Hook が `~/.claude/settings.json` に入っていない | `install-hooks.sh --apply` を再実行 |
| hot.md が LLM に届かない | `$OBSIDIAN_VAULT` env 未設定 / Vault 外シムリンク escape | `echo $OBSIDIAN_VAULT` で確認、`realpath` で link 先確認 |
| auto-ingest が動かない | LaunchAgent / cron 未インストール | `install-schedule.sh` を実行 / `launchctl list | grep kioku` で確認 |
| `.mcpb` 側と plugin 側の衝突 | 両方 install | 1 方法のみに絞る (本書の方法 2 推奨なら `.mcpb` を Claude Desktop から uninstall) |

## 関連

- [README](../README.md) — プロダクト概要
- [SECURITY.md](../SECURITY.md) — セキュリティポリシー (CVE / Safe Harbor / Disclosure Timeline)
- [context/context.md](../context/context.md) — 実装の INDEX
- [app/README.md](../app/README.md) — 方法 3 manual setup 詳細

## リンク

- Repository: https://github.com/megaphone-tokyo/kioku
- Releases: https://github.com/megaphone-tokyo/kioku/releases
- Issues: https://github.com/megaphone-tokyo/kioku/issues
