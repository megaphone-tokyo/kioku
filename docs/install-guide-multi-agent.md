---
title: Install KIOKU in non-Claude agents via MCP
updated: 2026-04-24
---

# KIOKU Multi-Agent MCP Setup

KIOKU ships an MCP-compliant stdio server at `mcp/server.mjs` that exposes
**11 tools**: `kioku_read`, `kioku_list`, `kioku_search`, `kioku_write_note`,
`kioku_write_wiki`, `kioku_delete`, `kioku_ingest_pdf`, `kioku_ingest_document`,
`kioku_ingest_url`, `kioku_generate_viz`, `kioku_health`.

Because the server speaks the Model Context Protocol, any MCP-capable client
can drive it — not just Claude Code / Claude Desktop. This guide shows how to
register KIOKU in three non-Claude agent CLIs:

- [Codex CLI](#codex-cli) (OpenAI) — `~/.codex/config.toml`
- [Gemini CLI](#gemini-cli) (Google) — `~/.gemini/settings.json`
- [OpenCode](#opencode) (sst) — `~/.config/opencode/opencode.json` or `./opencode.json`

If you use Claude Code or Claude Desktop, see
[install-guide-plugin.md](install-guide-plugin.md) instead — that path is fully
tested and benefits from KIOKU's auto-ingest hooks.

## Scope: MCP tools only

This guide covers **MCP tool access only** — i.e. your agent can call
`kioku_list`, `kioku_search`, etc. during a chat.

What this guide does **not** cover:

- **Session auto-logging** — KIOKU's `hooks/session-logger.mjs` is designed
  against Claude Code's hook schema (`SessionStart` / `Stop` / `PostToolUse` /
  `SessionEnd`). Porting it to Codex / Gemini / OpenCode is tracked as a
  separate Q2 delivery.
- **Automatic `hot.md` injection** — also relies on Claude Code's session
  lifecycle hooks; same Q2 delivery.
- **Scheduled auto-ingest** — `scripts/install/internal/install-schedule.sh` is agent-agnostic
  (LaunchAgent / cron), so the Ingest cycle runs even when the agent is not
  Claude. You still get fresh wiki/ generation from raw-sources/.

## Verification status

Transparency matters for a docs-only delivery. Here is exactly what was tested
when this guide was written (2026-04-24):

| Layer | Status | Evidence |
|---|---|---|
| MCP protocol compliance of `mcp/server.mjs` | **Verified** | Direct JSON-RPC `initialize` + `tools/list` + `tools/call kioku_list` against `node mcp/server.mjs` with a real Vault. Server returned `kioku-wiki` in `initialize`, 11 tools in `tools/list` (Sprint 2 v0.7.4: added `kioku_health`), and 13 top-level entries from `tools/call kioku_list`. |
| Per-CLI config-file integration (Codex / Gemini / OpenCode) | **Documented, not CLI-tested** | Config syntax below is quoted from each vendor's upstream docs (URLs cited per agent). End-to-end smoke tests (`codex` / `gemini` / `opencode` binaries + `kioku_list` round-trip) were **not** run in the delegation environment because the three CLIs were not installed and global npm install was declined by sandbox policy. |

If you run the end-to-end flow successfully in any of the three CLIs, a PR
adding the transcript (CLI version + `mcp list` output + `kioku_list`
round-trip) is very welcome — see [Contributing verification](#contributing-verification).

## Prerequisites

All three CLIs share the same setup prerequisites:

1. **KIOKU source tree on disk** — either `git clone https://github.com/megaphone-tokyo/kioku`
   or an installed Claude Code plugin at `~/.claude/plugins/kioku/`.
2. **Node.js >= 18** — `mcp/server.mjs` uses the MCP SDK and ES modules.
3. **MCP server dependencies installed** — from the KIOKU source root:
   ```bash
   cd "<kioku-root>/mcp" && npm install
   ```
4. **`OBSIDIAN_VAULT` env** exported (absolute path, no trailing slash):
   ```bash
   export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
   ```
5. The Vault directory must exist and contain `wiki/`, `raw-sources/`,
   `session-logs/`. Run `bash <kioku-root>/scripts/setup-vault.sh` once if the
   Vault is empty.

Record the absolute paths you will paste into each agent's config:

```bash
realpath "<kioku-root>/mcp/server.mjs"
# example: /Users/you/kioku/mcp/server.mjs

realpath "$OBSIDIAN_VAULT"
# example: /Users/you/claude-brain/main-claude-brain
```

## Codex CLI

Source: [openai/codex — `docs/config.md`](https://github.com/openai/codex/blob/main/docs/config.md)

### Config location

`~/.codex/config.toml` (user scope). Created on first Codex run if missing.

### Setup

Add one `[mcp_servers.kioku]` table:

```toml
[mcp_servers.kioku]
command = "node"
args = ["/absolute/path/to/kioku/mcp/server.mjs"]
env = { OBSIDIAN_VAULT = "/absolute/path/to/vault" }
startup_timeout_sec = 15
enabled = true
```

Replace both absolute paths with the values you recorded in Prerequisites.

### Verification

```bash
codex
```

Inside the Codex TUI, list available tools. You should see tool names
beginning with `kioku_`. Codex's MCP tool-listing surface has evolved
rapidly; consult `/help` inside the TUI for the current command if the
listing is not obvious.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `command not found: node` in startup log | `command = "node"` is resolved against Codex's spawn PATH, not your login shell | Use the absolute path: `command = "/usr/local/bin/node"` (check with `command -v node`) |
| MCP startup timeout | Large Vault or slow SSD | Raise `startup_timeout_sec` to `30` |
| `[kioku-mcp] OBSIDIAN_VAULT is required.` in stderr | `env` table not loaded | Verify TOML inline-table syntax: `env = { OBSIDIAN_VAULT = "..." }` (note `=` inside braces, no `:` JSON-style) |

**Verification status:** Unverified in the delegation environment. Please
report any schema mismatch observed against a specific Codex CLI version via
[Issues](https://github.com/megaphone-tokyo/kioku/issues).

### Note on per-turn commits (only if you also install the Hook port)

If you have run `bash scripts/install/user/install-hooks-codex.sh --apply` (Q2 Hook port,
v0.7.0), be aware that **Codex CLI lacks a `SessionEnd` event**, so KIOKU
emulates the Claude end-of-session `git add/commit/push` step on the `Stop`
event (= turn end). This means **a single Codex session can produce dozens of
commits** — one per turn that touched `wiki/` / `raw-sources/` / `templates/` /
`CLAUDE.md`. Turns with no changes are silently skipped (git refuses empty
commits), so the count is bounded by actual edits, not by turn count alone.

If the resulting `git log` noise is unacceptable for your workflow:

- Inspect with `git log --oneline` periodically to gauge real churn.
- Disable only the second-stage git-sync hook by removing the shell one-liner
  entry from `~/.codex/hooks.json` (the `Stop` array's second element). The
  first-stage `node hooks/adapters/codex.mjs` entry will continue to record
  session logs locally — only the auto-push to GitHub stops.
- This is a known design trade-off, not a bug. SessionEnd support is tracked
  in Codex CLI [issue #17333](https://github.com/openai/codex/issues/17333).

## Gemini CLI

Source: [google-gemini/gemini-cli — `docs/tools/mcp-server.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

### Config location

- User scope: `~/.gemini/settings.json`
- Project scope: `./.gemini/settings.json` (takes precedence when running from a project)

### Setup

Add an `mcpServers.kioku` entry in `settings.json`:

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

Or use the shell helper (creates / updates `settings.json` for you):

```bash
gemini mcp add kioku node /absolute/path/to/kioku/mcp/server.mjs \
  --env OBSIDIAN_VAULT=/absolute/path/to/vault \
  --timeout 30000
```

### Verification

```bash
# Non-interactive
gemini mcp list
# => kioku should appear with connected / ready status

# Interactive
gemini
> /mcp
# Shows server list + connection status + discovered tools
```

Gemini CLI namespaces MCP tools as `mcp_<serverName>_<toolName>`, so from
a prompt you reference `mcp_kioku_kioku_list` (double `kioku` is the server
name plus the tool name).

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gemini mcp list` shows `kioku` as **disconnected** | Server exited during startup | Re-run with `KIOKU_DEBUG=1 gemini` and inspect the Gemini CLI log directory for stderr from `[kioku-mcp]` |
| Tool-call confirmation prompts on every invocation | Default `"trust": false` | Set `"trust": true` only for a Vault you own (this bypasses safety prompts for every `kioku_*` call) |
| `OBSIDIAN_VAULT` unset at server startup | Used bash-style `$VAR` without a defined shell var | Inline the absolute path inside `env`, or export the var in the shell that spawns `gemini` |
| Tool name collisions with other MCP servers | Two servers exposing `kioku_*`-prefixed names | Use `includeTools` / `excludeTools` to scope (see upstream docs) |

**Verification status:** Unverified in the delegation environment. The config
schema is stable in upstream docs as of 2026-04-24.

## OpenCode

Sources: [opencode.ai — MCP servers](https://opencode.ai/docs/mcp-servers/) + [OpenCode config](https://opencode.ai/docs/config/)

### Config location

- User scope: `~/.config/opencode/opencode.json`
- Project scope: `./opencode.json` (walked up to nearest `.git` root)

Both files share the same schema; project config is merged over user config.

### Setup

Add an `mcp.kioku` entry:

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

Two OpenCode-specific gotchas vs. Codex / Gemini:

- `command` is a **single string array** (`["node", "path"]`) — there is no
  separate `args` field.
- The env map is named `environment`, not `env`.

### Verification

```bash
opencode mcp list
# => kioku should appear; auth: n/a for local stdio servers
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `kioku` missing from `opencode mcp list` | Wrong config scope or path | Confirm OpenCode picked up your config: `opencode` logs which file it loaded at startup; otherwise move config to `~/.config/opencode/opencode.json` |
| Server exits immediately | `OBSIDIAN_VAULT` missing — shell env is not inherited by MCP subprocesses | Put the absolute Vault path inside `environment`, not just in your shell |
| `timeout` hits during first run | First-run `mcp/node_modules` resolution on slow disk | Raise `timeout` to `30000` |

**Verification status:** Unverified in the delegation environment. OpenCode's
MCP schema has seen field renames in the past — pin to a known OpenCode
version if you are scripting.

## Interactive end-to-end verifier (Gemini / Codex)

After wiring up Gemini CLI or Codex CLI with the install scripts above, you can
confirm the full hook pipeline with an **interactive helper**:

```bash
# Gemini CLI end-to-end
bash scripts/verify-multi-agent-e2e.sh --agent=gemini

# Codex CLI end-to-end
bash scripts/verify-multi-agent-e2e.sh --agent=codex
```

The helper walks you through six steps:

1. CLI install check (`gemini --version` / `codex --version`)
2. CLI auth reminder (best-effort)
3. KIOKU hook apply (invokes `install-hooks-<agent>.sh --apply`)
4. Config structure verification (`~/.<agent>/settings.json` or `hooks.json` — required keys)
5. Prompts you to run one agent session manually in another terminal
6. Inspects the newest file under `$OBSIDIAN_VAULT/session-logs/`:
   - confirms frontmatter carries `agent: <agent>`
   - runs a masking spot check (fails fast if `sk-proj-…` / `sk-ant-…` / `ghp_…` / `AKIA…` patterns are unmasked)
   - for Codex, also reports per-turn git-sync commits from the last 15 minutes

Once you have already run one session, you can re-run just the log-inspection
part without going through install again:

```bash
bash scripts/verify-multi-agent-e2e.sh --agent=gemini --verify-only
```

Set `KIOKU_VERIFY_DEBUG=1` for a full `jq` dump of the resolved hook config.

Scope: this helper covers Gemini and Codex only. Claude Code continues to be
verified via `install-hooks.sh` and its existing test suite; OpenCode is out
of scope for v0.7.0 (deferred pending demand).

## Verify the server itself (agent-agnostic)

Regardless of which CLI you are wiring up, you can prove the KIOKU MCP server
is healthy with a direct JSON-RPC smoke test — no CLI required. Save the
following as `verify-kioku-mcp.mjs`:

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

Run it:

```bash
OBSIDIAN_VAULT=/absolute/path/to/vault \
  node verify-kioku-mcp.mjs /absolute/path/to/kioku/mcp/server.mjs
```

Expected output on a seeded Vault:

```
initialize: { name: 'kioku-wiki', version: '0.1.0' }
tools/list: 11 tools
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
  - kioku_health
kioku_list: <n> entries
```

If this protocol layer passes, any MCP-spec-compliant client — including the
three agents above — will succeed on configuration alone. If this layer fails,
the problem is upstream of your agent's config (usually `OBSIDIAN_VAULT` or
`mcp/node_modules/`).

## Contributing verification

PRs that replace one of the three "Unverified in the delegation environment"
banners above with a real verification transcript are welcome. Include:

- Exact CLI version (`codex --version` / `gemini --version` / `opencode --version`)
- macOS / Linux distro
- `<cli> mcp list` output showing `kioku`
- A round-trip `kioku_list` or `kioku_search` transcript

Open an issue first if you hit a schema mismatch with the documented config —
vendor CLIs iterate, and this guide will be pinned to known-good versions.

## Related

- [install-guide-plugin.md](install-guide-plugin.md) — Claude Code / Claude Desktop (tested path)
- [install-guide-multi-agent.ja.md](install-guide-multi-agent.ja.md) — 日本語版
- `scripts/setup-multi-agent.sh` — Symlinks KIOKU **skills** (not MCP tools) into Codex / Gemini / OpenCode skill-discovery paths; run it in addition to this MCP setup if you want both layers.
- [`mcp/server.mjs`](../mcp/server.mjs) — KIOKU MCP server source
- [`mcp/manifest.json`](../mcp/manifest.json) — MCPB packaging metadata (Claude Desktop DXT bundle; note: lists only 8 of the 10 runtime tools as of v0.6.0, tracked as a drift to reconcile)
- [Model Context Protocol](https://modelcontextprotocol.io/) — upstream spec
