## This manual is available in multiple languages

> [!NOTE]
> **🌐 Available in:** 🇬🇧 **English** · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code forgets knowledge from past sessions as they go.
kioku **automatically accumulates your conversations into a Wiki** and **recalls them in the next session**.

No more repeating the same explanations over and over.
A "second brain" that grows with every use — for your Claude.

<br>

## What It Does

Automatically record Claude Code sessions and build a structured knowledge base on an Obsidian Vault.

Combines Andrej Karpathy's LLM Wiki pattern with auto-logging and Git sync across multiple machines.

```
🗣️  You chat with Claude Code as usual
         ↓  (everything is recorded automatically — you don't do anything)
📝  Session logs saved locally
         ↓  (a scheduled job asks AI to read the logs and extract knowledge)
📚  Wiki grows with each session — concepts, decisions, patterns
         ↓  (synced via Git)
☁️  GitHub keeps your Wiki backed up and shared across machines
```

1. **Auto-capture (L0)**: Captures Claude Code hook events (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) and writes Markdown to `session-logs/`
2. **Structuring (L1)**: Scheduled execution (macOS LaunchAgent / Linux cron) has the LLM read unprocessed logs and build concept pages, project pages, and design decisions in `wiki/`. Session insights are also saved to `wiki/analyses/`
3. **Integrity check (L2)**: Monthly wiki health check generates `wiki/lint-report.md`. Automatic secret leak detection included
4. **Sync (L3)**: The Vault itself is a Git repo. `SessionStart` runs `git pull`, `SessionEnd` runs `git commit && git push`, syncing across machines via a GitHub Private repository
5. **Wiki context injection**: At `SessionStart`, `wiki/index.md` is injected into the system prompt so Claude can leverage past knowledge
6. **qmd full-text search**: Search wiki via MCP with BM25 + semantic search
7. **Wiki Ingest skills**: `/wiki-ingest-all` and `/wiki-ingest` slash commands import existing project knowledge into the Wiki
8. **Secret isolation**: `session-logs/` stays local per machine (`.gitignore`). Only `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` are Git-managed

<br>

## Important Notes

> [!CAUTION]
> KIOKU currently requires **Claude Code (Max plan)**. The Hook system (L0) and Wiki context injection are Claude Code-specific features. The Ingest/Lint pipeline (L1/L2) can work with other LLM APIs by swapping the `claude -p` call — this is planned as a future enhancement.

> [!IMPORTANT]
> This software is provided **"as is"**, without warranty of any kind. The authors assume **no responsibility** for any data loss, security incidents, or damages arising from the use of this tool. Use at your own risk. See [LICENSE](LICENSE) for full terms.

<br>

## Prerequisites

| | Version / Requirement |
|---|---|
| macOS | 13+ recommended |
| Node.js | 18+ (hook scripts are `.mjs` ES Modules, zero external dependencies) |
| Bash | 3.2+ (macOS default) |
| Git | 2.x+. Must support `git pull --rebase` / `git push` |
| GitHub CLI | Optional (`gh` simplifies private repo creation) |
| Claude Code | **Max plan** required (uses `claude` CLI and Hook system in `~/.claude/settings.json`) |
| Obsidian | One Vault created in any folder (iCloud Drive not required) |
| jq | 1.6+ (used by `install-hooks.sh --apply`) |
| Env var | `OBSIDIAN_VAULT` pointing to the Vault root |

<br>

## Quick Start

> [!WARNING]
> **Understand before you install:** KIOKU hooks into **all Claude Code session I/O**. This means:
> - Session logs may contain **API keys, tokens, or personal information** from your prompts and tool output. Masking covers major patterns but is not exhaustive — review [SECURITY.md](SECURITY.md)
> - If `.gitignore` is misconfigured, session logs could be **accidentally pushed to GitHub**
> - The auto-ingest pipeline sends session log content to Claude via `claude -p` for Wiki extraction
>
> We recommend starting with `KIOKU_DRY_RUN=1` to verify the pipeline before enabling full operation.

### 🚀 Interactive Setup (Recommended)

> [!NOTE]
> Enter the following in Claude Code to start an interactive, guided setup. It explains each step's purpose and adapts to your environment.

```
Please read skills/setup-guide/SKILL.md and guide me through the KIOKU installation.
```

### 🛠️ Manual Setup

> [!NOTE]
> For those who want to understand each step. Run the scripts directly.

#### 1. Create a Vault and connect it to a Git repository (manual)

1. Create a new Vault in Obsidian (e.g., `~/kioku/main-kioku`)
2. Create a Private repository on GitHub (e.g., `kioku`)
3. In the Vault directory: `git init && git remote add origin ...` (or `gh repo create --private --source=. --push`)

This step is not automated by KIOKU scripts. GitHub authentication (gh CLI / SSH keys) depends on your environment.

#### 2. Set the environment variable

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Initialize the Vault

```bash
# Creates raw-sources/, session-logs/, wiki/, templates/ under the Vault,
# places CLAUDE.md / .gitignore / initial templates (never overwrites existing files)
bash scripts/setup-vault.sh
```

#### 4. Install Hooks

```bash
# Option A: Auto-merge (recommended, requires jq)
bash scripts/install-hooks.sh --apply
# Creates backup → shows diff → confirmation prompt → adds hook entries preserving existing config

# Option B: Manual merge
bash scripts/install-hooks.sh
# Outputs JSON snippet to stdout for manual merge into ~/.claude/settings.json
```

#### 5. Verify

Restart Claude Code, then have one conversation.
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` should appear.

> **Steps 1–5 are required.** The following are optional but recommended for full functionality.

#### 6. Set up scheduled execution (recommended)

Configure automatic Ingest (daily) and Lint (monthly).

```bash
# Auto-detects OS: macOS → LaunchAgent, Linux → cron
bash scripts/install-schedule.sh

# Test with DRY RUN first
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **macOS note**: Placing the repo under `~/Documents/` or `~/Desktop/` may cause TCC (Transparency, Consent, Control) to block background access with EPERM. Use a path outside protected directories (e.g., `~/_PROJECT/`).

#### 7. Set up qmd search engine (optional)

Enable MCP-powered full-text and semantic search for the Wiki.

```bash
bash scripts/setup-qmd.sh
bash scripts/install-qmd-daemon.sh
```

#### 8. Install Wiki Ingest skills (optional)

```bash
bash scripts/install-skills.sh
```

#### 9. Deploy to additional machines

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Open ~/kioku/main-kioku/ as a Vault in Obsidian
# Repeat steps 2–6
```

#### 10. MCP server for Claude Desktop / Code (optional)

Claude Desktop has no Hook system, so it cannot record sessions automatically.
The **`kioku-wiki` MCP server** lets both Claude Desktop and Claude Code search, read, and write the Wiki manually.

```bash
# 1. Install dependency (only inside mcp/, parent repo stays package.json-free)
bash scripts/setup-mcp.sh

# 2. Smoke test with the official Inspector
npx @modelcontextprotocol/inspector node mcp/server.mjs

# 3. Preview client-config changes
bash scripts/install-mcp-client.sh --dry-run

# 4. Apply (merges into ~/Library/Application Support/Claude/claude_desktop_config.json)
bash scripts/install-mcp-client.sh --apply

# 5. Register with Claude Code (CLI / VSCode) via the printed stdio command
claude mcp add --scope user --transport stdio kioku \
  "$(command -v node)" "$(pwd)/mcp/server.mjs"
```

Six tools provided:

| Tool | Purpose |
|---|---|
| `kioku_search` | Wiki search (delegates to qmd CLI; falls back to a simple Node grep when qmd is unavailable) |
| `kioku_read` | Return the contents of `wiki/<path>.md` |
| `kioku_list` | Walk the `wiki/` directory tree |
| `kioku_write_note` (recommended) | Append a memo to `session-logs/`; the next auto-ingest cycle structures it into `wiki/` |
| `kioku_write_wiki` (advanced) | Write directly into `wiki/` with template + frontmatter auto-injection |
| `kioku_delete` | Move a page to `wiki/.archive/` (recoverable; `wiki/index.md` cannot be deleted) |

**Notes**:
- Fully local (stdio transport, no network exposure, single dep `@modelcontextprotocol/sdk`)
- For "save this to my wiki" prompts in Desktop, **prefer `kioku_write_note`** — it preserves wiki coherence
- Use `kioku_write_wiki` only when the user explicitly wants the page to appear immediately
- Coexists with the existing qmd MCP (HTTP :8181). Prefer the qmd MCP `search` tool when available; `kioku_search` is the fallback.

##### Persistence & when to re-run

**Once installed, you do not need to restart or re-run anything on reboot.** The MCP server is spawned on-demand by Claude Desktop / Claude Code when a new conversation opens, and terminates when the conversation ends — there's no daemon to manage. OS reboots, Desktop relaunches, and Claude Code restarts all "just work".

Re-run the steps only in these specific cases:

| Trigger | Re-run |
|---|---|
| Moved the repo to a different directory | Steps 3 & 5 (they record absolute paths to `mcp/server.mjs`) |
| Switched Node version (mise / nvm / Volta) | Step 3 (the script hardcodes `command -v node`) |
| Changed the `OBSIDIAN_VAULT` env var | Step 3 (the value is baked into the config at apply time) |
| `@modelcontextprotocol/sdk` major version bump | Step 1 (`setup-mcp.sh` to refresh `node_modules`) |

Uninstall:

```bash
bash scripts/install-mcp-client.sh --uninstall
rm -rf mcp/node_modules
```

#### 11. MCPB bundle for Claude Desktop (one-file install)

If you only use **Claude Desktop** and want the shortest install path, install the [MCPB](https://github.com/anthropics/mcpb) bundle with a single drag & drop. The bundle includes `mcp/server.mjs` and all production dependencies; Claude Desktop launches it with its built-in Node runtime, so end users **do not need to install Node themselves**.

##### Option A — Install a pre-built release (recommended for end users)

1. Download the latest **`kioku-wiki-<version>.mcpb`** from [github.com/megaphone-tokyo/kioku/releases](https://github.com/megaphone-tokyo/kioku/releases)
2. Open **Claude Desktop**
3. Either:
   - **Double-click** the `.mcpb` file in Finder (macOS associates `.mcpb` with Claude Desktop), or
   - Open **Settings → Extensions / Connectors** and drag the `.mcpb` onto that screen
   - (Don't drop it on the chat window — it'll be treated as a file attachment)
4. In the install dialog, pick your **Vault directory** (the folder containing `wiki/`, `session-logs/`, `raw-sources/`) → **Install**
5. Open **Settings → Connectors** and confirm `KIOKU Wiki` is enabled
6. Start a **new** chat and try: `kioku_read で wiki/index.md を読んで` (existing chats won't see the new tools)

> **Note**: Claude Desktop will warn that the extension has not been verified by Anthropic. This is expected — `mcpb sign` for code signing is a planned future enhancement.

##### Option B — Build from source (developers / contributors)

```bash
# 1. Build the .mcpb bundle (writes mcp/dist/kioku-wiki-<version>.mcpb, ~3.2 MB)
bash scripts/build-mcpb.sh

# 2. (Optional) validate manifest + inspect contents
bash scripts/build-mcpb.sh --validate
npx --yes @anthropic-ai/mcpb info mcp/dist/kioku-wiki-0.1.0.mcpb

# 3. Clean build artifacts
bash scripts/build-mcpb.sh --clean
```

The bundle is **gitignored** (`mcp/build/`, `mcp/dist/`). To publish a new release, run `build-mcpb.sh` and attach the resulting `.mcpb` to a new [GitHub Release](https://github.com/megaphone-tokyo/kioku/releases). End users will then download it via Option A.

The traditional install paths in step 10 still work — MCPB is purely an *additional* delivery channel for Desktop-first users.

##### Persistence & when to re-install

**Once installed, the `.mcpb` persists through reboots and Desktop restarts.** Claude Desktop auto-spawns the server when a new conversation opens — you don't need to relaunch anything manually.

Re-install only in these cases:

| Trigger | Action |
|---|---|
| Moved your Obsidian Vault directory | Re-run the install (the dialog will re-ask for Vault directory) OR edit `~/Library/Application Support/Claude/claude_desktop_config.json` manually |
| New `.mcpb` version released | Download the new `.mcpb` and drag-install; Desktop replaces the existing extension in place |
| Uninstalled via Settings → Connectors by accident | Drag the same `.mcpb` back in |

Unlike § 10, MCPB is self-contained — **switching Node versions or updating `@modelcontextprotocol/sdk` do NOT affect an already-installed `.mcpb`** (the bundle ships its own dependencies and launches via Desktop's built-in Node runtime).

<br>

## Directory Structure

```

├── README.md                        ← This file
├── hooks/
│   ├── session-logger.mjs           ← Hook entry point (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: inject wiki/index.md into system prompt
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Bulk project-to-Wiki import slash command
│   └── wiki-ingest/SKILL.md         ← Targeted scan slash command
├── templates/
│   ├── vault/                       ← Vault root files (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Note templates (concept, project, decision, source-summary)
│   ├── wiki/                        ← Initial wiki files (index.md, log.md)
│   └── launchd/*.plist.template     ← macOS LaunchAgent templates
├── scripts/
│   ├── setup-vault.sh               ← Vault initialization (idempotent)
│   ├── install-hooks.sh             ← Hook config snippet output / --apply for auto-merge
│   ├── auto-ingest.sh               ← Scheduled: ingest unprocessed logs into wiki
│   ├── auto-lint.sh                 ← Scheduled: wiki health report + secret scanning
│   ├── install-cron.sh              ← Output cron entries to stdout
│   ├── install-schedule.sh          ← OS-aware dispatcher (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← macOS LaunchAgent installer
│   ├── setup-qmd.sh                 ← qmd collection registration + initial indexing
│   ├── install-qmd-daemon.sh        ← qmd MCP HTTP server as launchd daemon
│   ├── install-skills.sh            ← Symlink wiki-ingest skills to ~/.claude/skills/
│   └── scan-secrets.sh              ← Secret leak detection in session-logs/
└── tests/                           ← node --test and bash smoke tests
```

<br>

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | none (required) | Vault root. auto-ingest/lint fall back to `${HOME}/kioku/main-kioku` |
| `KIOKU_DRY_RUN` | `0` | `1` to skip `claude -p` calls (path verification only) |
| `KIOKU_NO_LOG` | unset | `1` to suppress session-logger.mjs (prevents recursive logging from cron subprocesses) |
| `KIOKU_DEBUG` | unset | `1` to emit debug info to stderr and `session-logs/.kioku/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ingest log output path (referenced by auto-lint self-diagnostics) |

### Node Version Manager PATH Setup

Scheduled scripts (`auto-ingest.sh`, `auto-lint.sh`) run from cron / LaunchAgent and don't inherit your interactive shell's PATH. They add Volta (`~/.volta/bin`) and mise (`~/.local/share/mise/shims`) to PATH. **If you use nvm / fnm / asdf or another version manager**, edit the `export PATH=...` line at the top of each script:

```bash
# nvm example
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# fnm example
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Design Notes

- **Session logs contain secrets**: Prompts and tool output may include API keys, tokens, or PII. `session-logger.mjs` applies regex masking before writing
- **Write boundary**: Hooks only write to `$OBSIDIAN_VAULT/session-logs/`. They never touch `raw-sources/`, `wiki/`, or `templates/`
- **session-logs never reach Git**: Excluded by `.gitignore`, minimizing the risk of accidental pushes to GitHub
- **No network access**: Hook scripts (`session-logger.mjs`) do not import `http`/`https`/`net`/`dgram`. Git sync is handled by shell one-liners in the Hook config
- **Idempotent**: `setup-vault.sh` / `install-hooks.sh` can be run multiple times without destroying existing files
- **No git init**: `setup-vault.sh` does not initialize a Git repo or add remotes. GitHub authentication is the user's responsibility

<br>

## Multi-Machine Setup

KIOKU is designed to **share a single Wiki across multiple machines** via Git sync.
The author runs a two-Mac setup: a MacBook (primary dev machine) and a Mac mini (for Claude Code bypass permission mode).

Key points for multi-machine operation:
- **`session-logs/` stays local per machine** (excluded by `.gitignore`). Each machine's session logs are independent and never pushed to Git
- **`wiki/` is Git-synced**. Ingest results from any machine accumulate in the same Wiki
- **Stagger Ingest/Lint execution times** across machines to avoid git push conflicts
- SessionEnd Hook auto commit/push is enabled on all machines, but normal coding sessions only write to `session-logs/` — git operations only trigger when `wiki/` is directly modified

Reference: author's two-Mac configuration

| | MacBook (primary) | Mac mini (bypass) |
|---|---|---|
| Secrets | Yes | No |
| `session-logs/` | Local only | Local only |
| `wiki/` | Git-synced | Git-synced |
| Ingest schedule | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint schedule | 1st of month 8:00 | 2nd of month 8:00 |
| Scheduler | LaunchAgent | LaunchAgent |

> If you're running on a single machine, you can ignore this section entirely. The Quick Start steps are all you need.

<br>

## Security

KIOKU is a Hook system that accesses **all Claude Code session I/O**.
See [SECURITY.md](SECURITY.md) for the full security design.

### Defense Layers

| Layer | Description |
|---|---|
| **Input validation** | `OBSIDIAN_VAULT` path checked for shell metacharacters and JSON/XML control characters |
| **Masking** | API keys (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), Bearer/Basic auth, URL credentials, PEM private keys replaced with `***` |
| **Permissions** | `session-logs/` created with `0o700`, log files with `0o600`. Hook scripts set to `chmod 755` |
| **.gitignore guard** | Verifies `.gitignore` contains `session-logs/` before every git commit |
| **Recursion prevention** | `KIOKU_NO_LOG=1` + cwd-in-vault check (double guard) prevents recursive logging from subprocesses |
| **LLM permission restriction** | auto-ingest / auto-lint run `claude -p` with `--allowedTools Write,Read,Edit` (no Bash) |
| **Periodic scanning** | `scan-secrets.sh` scans session-logs/ monthly for known token patterns to detect masking failures |

### Adding Token Patterns

When you start using a new cloud service, add its token pattern to both `hooks/session-logger.mjs` (`MASK_RULES`) and `scripts/scan-secrets.sh` (`PATTERNS`).

### Reporting Vulnerabilities

If you find a security issue, please report it via [SECURITY.md](SECURITY.md) — not through public Issues.

<br>

## Roadmap

### Near-term
- [ ] **Ingest quality tuning** — Review and adjust selection criteria in Vault CLAUDE.md after 2 weeks of real-world Ingest runs
- [ ] **qmd multilingual search** — Verify semantic search accuracy for non-English content; swap embedding model if needed (e.g., `multilingual-e5-small`)
- [ ] **Safe auto-fix skill (`/wiki-fix-safe`)** — Auto-fix trivial Lint issues (add missing cross-links, fill frontmatter gaps) with human approval
- [ ] **Git sync error visibility** — Log `git push` failures to `session-logs/.kioku/git-sync.log` and surface warnings in auto-ingest

### Mid-term
- [ ] **Multi-LLM support** — Replace `claude -p` in auto-ingest/lint with a pluggable LLM backend (OpenAI API, local models via Ollama, etc.)
- [ ] **CI/CD** — GitHub Actions for automated testing on push
- [ ] **Lint diff notifications** — Show only *newly detected* issues by diffing against the previous lint report
- [ ] **Optimistic locking for index.json** — Prevent lost updates when multiple Claude Code sessions run in parallel

### Long-term
- [ ] **Morning Briefing** — Auto-generate a daily summary (yesterday's sessions, open decisions, new insights) as `wiki/daily/YYYY-MM-DD.md`
- [ ] **Project-aware context injection** — Filter `wiki/index.md` by the current project (based on `cwd`) to stay within the 10,000-char limit
- [ ] **Stack recommendation skill (`/wiki-suggest-stack`)** — Suggest tech stacks for new projects based on accumulated Wiki knowledge
- [ ] **Team Wiki** — Multi-person Wiki sharing (each member's session-logs stay local; only wiki/ is shared via Git)

> **Note**: KIOKU currently requires **Claude Code (Max plan)**. The Hook system (L0) and Wiki context injection are Claude Code-specific. The Ingest/Lint pipeline (L1/L2) can work with other LLM APIs by swapping the `claude -p` call — this is planned as a future enhancement.

<br>

## Changelog

### 2026-04-17 — Phase N: MCPB bundle for Claude Desktop
- New `mcp/manifest.json` (MCPB v0.4) and `scripts/build-mcpb.sh` produce `kioku-wiki-<version>.mcpb` (~3.2 MB)
- Claude Desktop users can install the MCP server with a single drag & drop; `OBSIDIAN_VAULT` is configured via the install dialog's directory picker (no Node toolchain required on the user's machine — Desktop's bundled runtime is used)
- See **§ 11** above for build / install steps

### 2026-04-17 — Phase M: kioku-wiki MCP server
- Local stdio MCP server (`mcp/`) exposing six tools — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Both Claude Desktop and Claude Code can now browse, search, and update the Wiki on demand without leaving the chat
- See **§ 10** above for setup

### 2026-04-16 — Phase L: macOS LaunchAgent migration
- New `scripts/install-schedule.sh` dispatcher chooses macOS LaunchAgent or Linux cron automatically
- Resolves the structural impossibility of cron loading the user's full PATH on macOS

<br>

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

As noted in the "Important Notes" section above, this software is provided "as is" without warranty of any kind.

<br>

## References

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — The original concept this project implements
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Official Hook system documentation
- [Obsidian](https://obsidian.md/) — The knowledge management app used as the Wiki viewer
- [qmd](https://github.com/tobi/qmd) — Local search engine for Markdown (BM25 + vector search)

<br>


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## Author

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Building things with code and AI. Freelance engineer, 10 years in. Frontend-focused, lately co-developing with Claude as my main workflow.

[Follow me on X](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
