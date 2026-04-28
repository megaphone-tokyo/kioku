---
title: KIOKU を Claude 以外のエージェントで MCP 経由で使う
updated: 2026-04-24
---

# KIOKU Multi-Agent MCP Setup (日本語版)

KIOKU は MCP 準拠の stdio サーバー `mcp/server.mjs` を同梱しており、
**10 種類の tool** を公開しています: `kioku_read` / `kioku_list` /
`kioku_search` / `kioku_write_note` / `kioku_write_wiki` / `kioku_delete` /
`kioku_ingest_pdf` / `kioku_ingest_document` / `kioku_ingest_url` /
`kioku_generate_viz`。

サーバーが Model Context Protocol 仕様に従っているため、Claude Code /
Claude Desktop に限らず、MCP をサポートするエージェントから同じ tool を
呼び出せます。本書は以下の 3 つの非 Claude エージェント CLI に KIOKU MCP
サーバーを登録する手順をまとめます。

- [Codex CLI](#codex-cli) (OpenAI) — `~/.codex/config.toml`
- [Gemini CLI](#gemini-cli) (Google) — `~/.gemini/settings.json`
- [OpenCode](#opencode) (sst) — `~/.config/opencode/opencode.json` or `./opencode.json`

Claude Code / Claude Desktop を使っている場合は
[install-guide-plugin.md](install-guide-plugin.md) を参照してください
(こちらは動作確認済みの公式経路で、KIOKU の auto-ingest hook も全て使えます)。

## スコープ: MCP tool のみ

本書は **MCP tool 呼び出しのみ** を対象にします。Codex / Gemini / OpenCode
のチャット中に `kioku_list` や `kioku_search` を呼べるようにするのがゴールです。

本書が **カバーしない** もの:

- **session 自動ログ** — `hooks/session-logger.mjs` は Claude Code 固有の
  hook schema (`SessionStart` / `Stop` / `PostToolUse` / `SessionEnd`) 向けに
  書かれています。Codex / Gemini / OpenCode への port は Q2 の別 delivery で
  扱います。
- **`hot.md` 自動注入** — 同じく Claude Code の session lifecycle hook に依存。
  Q2 delivery で対応予定。
- **定期 auto-ingest** — `scripts/install-schedule.sh` は LaunchAgent / cron
  ベースで **agent 非依存**。エージェントが Claude でなくても、raw-sources/ から
  wiki/ 生成は動き続けます。

## 検証ステータス (LEARN#10 準拠)

docs-only delivery では透明性が重要なので、本書執筆時 (2026-04-24) に
実際に何を検証したか明示します:

| 層 | 状態 | 根拠 |
|---|---|---|
| `mcp/server.mjs` の MCP 仕様準拠 | **検証済** | `node mcp/server.mjs` に対し直接 JSON-RPC を送信 (`initialize` + `tools/list` + `tools/call kioku_list`)。サーバーは `kioku-wiki` と identify し、`tools/list` で 10 tool を返し、`tools/call kioku_list` は実 Vault から 13 entry を返却。 |
| 各 CLI の config file 連携 (Codex / Gemini / OpenCode) | **未検証** | 下記 config 構文は各ベンダーの公式 docs 原文を引用 (各 agent 節に URL 明記)。`codex` / `gemini` / `opencode` バイナリを使った end-to-end の smoke test は、**本 delegation 環境で CLI が未インストールかつ `npm install -g` が sandbox policy で拒否された** ため実施できていません。 |

3 つの CLI のうち 1 つでも end-to-end が動いた方は、PR で transcript を追加
いただけると助かります。[検証への貢献](#検証への貢献)を参照。

## 前提

3 CLI 共通の準備:

1. **KIOKU のソースツリー** が手元にあること
   (`git clone https://github.com/megaphone-tokyo/kioku`、または
   Claude Code plugin としてインストール済なら `~/.claude/plugins/kioku/`)
2. **Node.js >= 18** — `mcp/server.mjs` は MCP SDK + ES Module 前提
3. **MCP server 依存 install** — KIOKU ソースルートで 1 回のみ:
   ```bash
   cd "<kioku-root>/mcp" && npm install
   ```
4. **`OBSIDIAN_VAULT` 環境変数** を shell profile に export
   (絶対パス、末尾スラッシュなし):
   ```bash
   export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
   ```
5. Vault ディレクトリに `wiki/` / `raw-sources/` / `session-logs/` が
   存在すること。空なら `bash <kioku-root>/scripts/setup-vault.sh` を 1 回実行

各 agent の config に貼り付ける絶対パスを記録しておきます:

```bash
realpath "<kioku-root>/mcp/server.mjs"
# 例: /Users/you/kioku/mcp/server.mjs

realpath "$OBSIDIAN_VAULT"
# 例: /Users/you/claude-brain/main-claude-brain
```

## Codex CLI

出典: [openai/codex — `docs/config.md`](https://github.com/openai/codex/blob/main/docs/config.md)

### Config 場所

`~/.codex/config.toml` (user scope)。初回起動時に自動生成されます。

### 設定

`[mcp_servers.kioku]` table を 1 つ追加:

```toml
[mcp_servers.kioku]
command = "node"
args = ["/absolute/path/to/kioku/mcp/server.mjs"]
env = { OBSIDIAN_VAULT = "/absolute/path/to/vault" }
startup_timeout_sec = 15
enabled = true
```

2 つの絶対パスを「前提」で記録した値に置き換えてください。

### 動作確認

```bash
codex
```

Codex TUI の中で利用可能な tool 一覧を表示すると、`kioku_` prefix で始まる
tool 名が見えるはずです。Codex の MCP tool 表示方法は活発に変わっているので、
具体的なコマンドは TUI 内 `/help` を参照してください。

### トラブルシューティング

| 症状 | 原因 | 解決 |
|---|---|---|
| 起動 log に `command not found: node` | `command = "node"` は Codex の spawn PATH で解決され、ログインシェルの PATH を継承しない | node の絶対パスを使う (`command -v node` で確認して `command = "/usr/local/bin/node"` 等) |
| MCP 起動 timeout | Vault が大きいまたは SSD が遅い | `startup_timeout_sec = 30` に引き上げ |
| stderr に `[kioku-mcp] OBSIDIAN_VAULT is required.` | `env` table が読まれていない | TOML の inline-table 構文を確認 (`env = { OBSIDIAN_VAULT = "..." }`、中括弧内は `=`、JSON 風の `:` ではない) |

**検証状態**: 本 delegation 環境では未検証。特定の Codex CLI version で
schema 齟齬が見つかった場合は [Issues](https://github.com/megaphone-tokyo/kioku/issues)
で報告お願いします。

## Gemini CLI

出典: [google-gemini/gemini-cli — `docs/tools/mcp-server.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

### Config 場所

- User scope: `~/.gemini/settings.json`
- Project scope: `./.gemini/settings.json` (project 実行時は project が優先)

### 設定

`settings.json` に `mcpServers.kioku` を追加:

```json
{
  "mcpServers": {
    "kioku": {
      "command": "node",
      "args": ["/absolute/path/to/kioku/mcp/server.mjs"],
      "env": {
        "OBSIDIAN_VAULT": "/absolute/path/to/vault"
      },
      "timeout": 30000,
      "trust": false
    }
  }
}
```

または shell helper で自動追加 (`settings.json` を自動作成 / 更新):

```bash
gemini mcp add kioku node /absolute/path/to/kioku/mcp/server.mjs \
  --env OBSIDIAN_VAULT=/absolute/path/to/vault \
  --timeout 30000
```

### 動作確認

```bash
# 非インタラクティブ: 登録済サーバー一覧
gemini mcp list
# => kioku が connected / ready 状態で表示される

# インタラクティブ: 接続状況 + discovered tools
gemini
> /mcp
```

Gemini CLI は MCP tool 名を `mcp_<serverName>_<toolName>` に namespace するため、
prompt からは `mcp_kioku_kioku_list` と指定します (server 名 `kioku` + tool 名
`kioku_list` で `kioku` が 2 回現れるのは仕様)。

### トラブルシューティング

| 症状 | 原因 | 解決 |
|---|---|---|
| `gemini mcp list` で kioku が **disconnected** | 起動時に kioku server が落ちている | `KIOKU_DEBUG=1 gemini` で実行し、Gemini CLI の log ディレクトリで `[kioku-mcp]` stderr を確認 |
| tool 呼び出しごとに確認 prompt | `"trust": false` がデフォルト | 自分の Vault なら `"trust": true` で抑止可 (`kioku_*` 呼び出し全てで safety prompt を bypass する点に注意) |
| 起動時に `OBSIDIAN_VAULT` が空 | `$VAR` 記法で shell 変数未 export | 絶対パスを `env` に直書きするか、`gemini` を起動する shell で `export` |
| 他 MCP server との tool 名衝突 | 別 server も `kioku_*` prefix を持つ場合 | `includeTools` / `excludeTools` で scope を絞る (上流 docs 参照) |

**検証状態**: 本 delegation 環境では未検証。上流 docs の schema は
2026-04-24 時点で安定しています。

## OpenCode

出典: [opencode.ai — MCP servers](https://opencode.ai/docs/mcp-servers/) + [OpenCode config](https://opencode.ai/docs/config/)

### Config 場所

- User scope: `~/.config/opencode/opencode.json`
- Project scope: `./opencode.json` (最寄りの `.git` root まで遡って探索)

同じ schema で、project config が user config に merge されます。

### 設定

`mcp.kioku` entry を追加:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kioku": {
      "type": "local",
      "command": ["node", "/absolute/path/to/kioku/mcp/server.mjs"],
      "environment": {
        "OBSIDIAN_VAULT": "/absolute/path/to/vault"
      },
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

Codex / Gemini と異なる OpenCode 固有の注意点 2 つ:

- `command` は **単一の string 配列** (`["node", "path"]`) で、`args` field は無い
- 環境変数の field 名は `env` ではなく **`environment`**

### 動作確認

```bash
opencode mcp list
# => kioku が表示される (local stdio のため auth は n/a)
```

### トラブルシューティング

| 症状 | 原因 | 解決 |
|---|---|---|
| `opencode mcp list` に kioku が出ない | config の scope / path が間違い | 起動時に OpenCode が読んだ config file path を log で確認。必要なら `~/.config/opencode/opencode.json` に移動 |
| server が即 exit | `OBSIDIAN_VAULT` 不足 — MCP 子プロセスは shell env を自動継承しない | 絶対パスを `environment` に直書き |
| 初回 `timeout` 発火 | `mcp/node_modules` の初回解決が遅い | `timeout` を `30000` に引き上げ |

**検証状態**: 本 delegation 環境では未検証。OpenCode の MCP schema は
過去に field 名 rename があったので、script 化する場合は動作確認済の
OpenCode version に pin するのを推奨。

## 対話式 E2E verifier (Gemini / Codex)

上記の install script で Gemini CLI / Codex CLI に hook を設定した後、**対話式 helper** で hook pipeline 全体を end-to-end で確認できます:

```bash
# Gemini CLI 向け E2E
bash scripts/verify-multi-agent-e2e.sh --agent=gemini

# Codex CLI 向け E2E
bash scripts/verify-multi-agent-e2e.sh --agent=codex
```

以下 6 step を自動で案内します:

1. CLI install 確認 (`gemini --version` / `codex --version`)
2. CLI auth の reminder (best-effort、session 起動時に確定検証)
3. KIOKU hook apply (内部で `install-hooks-<agent>.sh --apply` を idempotent 実行)
4. config 構造確認 (`~/.<agent>/settings.json` or `hooks.json` に必須 event key がある)
5. **別 terminal で 1 session を手動実行**するよう prompt (user 介入、簡単な prompt を入力して終了)
6. `$OBSIDIAN_VAULT/session-logs/` の最新 file を inspect:
   - frontmatter に `agent: <agent>` が入っているか確認
   - masking spot check (`sk-proj-…` / `sk-ant-…` / `ghp_…` / `AKIA…` pattern が unmasked で残っていれば fail)
   - Codex の場合は直近 15 分の per-turn git-sync commit 数も報告

既に 1 session 走らせた後に log の確認だけしたい場合は、install step を skip して log inspection だけ実行:

```bash
bash scripts/verify-multi-agent-e2e.sh --agent=gemini --verify-only
```

`KIOKU_VERIFY_DEBUG=1` を set すると resolved hook config を `jq` で full dump します (デバッグ用)。

スコープ: 本 helper は Gemini と Codex のみ対応。Claude Code は従来どおり `install-hooks.sh` と既存 test suite で動作確認、OpenCode は v0.7.0 スコープ外 (demand 次第で v0.7.x+ 対応検討)。

## サーバー単体の動作確認 (エージェント非依存)

どの CLI に入れる場合でも、KIOKU MCP server 自体が健全に動くことは CLI 無しで
直接 JSON-RPC smoke test で確認できます。以下を `verify-kioku-mcp.mjs` として
保存:

```js
import { spawn } from 'node:child_process';

const SERVER = process.argv[2];
const VAULT = process.env.OBSIDIAN_VAULT;
if (!SERVER || !VAULT) {
  console.error('Usage: OBSIDIAN_VAULT=/path node verify-kioku-mcp.mjs /path/to/server.mjs');
  process.exit(1);
}

const child = spawn('node', [SERVER], {
  env: { ...process.env, OBSIDIAN_VAULT: VAULT },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params, id) =>
  new Promise((r) => { pending.set(id, r); send({ jsonrpc: '2.0', id, method, params }); });

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'verify', version: '1.0' },
  }, 1);
  console.log('initialize:', init.result?.serverInfo);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {}, 2);
  const tools = list.result?.tools ?? [];
  console.log(`tools/list: ${tools.length} tools`);
  tools.forEach((t) => console.log(`  - ${t.name}`));

  const callRes = await request('tools/call', {
    name: 'kioku_list', arguments: { path: '.', depth: 1 },
  }, 3);
  const parsed = JSON.parse(callRes.result?.content?.[0]?.text ?? '{}');
  console.log(`kioku_list: ${parsed.entries?.length ?? 'n/a'} entries`);
} finally {
  child.kill();
}
```

実行:

```bash
OBSIDIAN_VAULT=/absolute/path/to/vault \
  node verify-kioku-mcp.mjs /absolute/path/to/kioku/mcp/server.mjs
```

Vault を seed 済の場合の期待出力:

```
initialize: { name: 'kioku-wiki', version: '0.1.0' }
tools/list: 10 tools
  - kioku_read
  - kioku_list
  - kioku_search
  - kioku_write_note
  - kioku_write_wiki
  - kioku_delete
  - kioku_ingest_pdf
  - kioku_ingest_document
  - kioku_ingest_url
  - kioku_generate_viz
kioku_list: <n> entries
```

この protocol 層さえ通れば、MCP 仕様準拠の任意 client (上記 3 agent を含む) は
config を正しく書けば繋がります。ここで失敗するなら、問題は agent config より
手前 (大抵 `OBSIDIAN_VAULT` 未設定か `mcp/node_modules/` 不足) です。

## 検証への貢献

上記 3 節の「検証状態: 未検証」banner を実 transcript に置き換える PR は歓迎です。
以下を含めてください:

- 正確な CLI version (`codex --version` / `gemini --version` / `opencode --version`)
- macOS / Linux distro
- `<cli> mcp list` の出力に `kioku` が出ている証跡
- `kioku_list` または `kioku_search` の round-trip transcript

公式 config と schema が齟齬する場合は、まず Issue を立てて報告ください。
ベンダー CLI の仕様は変わりうるので、本 guide は既知の動作 version に
pin し直す形で更新します。

## 関連

- [install-guide-plugin.md](install-guide-plugin.md) — Claude Code / Claude Desktop (動作確認済の経路)
- [install-guide-multi-agent.md](install-guide-multi-agent.md) — English version
- `scripts/setup-multi-agent.sh` — KIOKU の **skill** を Codex / Gemini / OpenCode の skill 探索 path に symlink する script (MCP tool ではない)。MCP 設定と併用可。
- [`mcp/server.mjs`](../mcp/server.mjs) — KIOKU MCP server 本体
- [`mcp/manifest.json`](../mcp/manifest.json) — MCPB packaging metadata (Claude Desktop DXT bundle 用。v0.6.0 時点で実 runtime 10 tool のうち 8 tool しか列挙されていない drift が判明しており、別途修正予定)
- [Model Context Protocol](https://modelcontextprotocol.io/) — 上流仕様
