## This manual is available in multiple languages

> [!NOTE]
> **🌐 Available in:** 🇬🇧 **English** · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code forgets knowledge from past sessions as they go.
KIOKU **automatically accumulates your conversations into a Wiki** and **recalls them in the next session**.

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
> This software is provided **"as is"**, without warranty of any kind. The authors assume **no responsibility** for any data loss, security incidents, or damages arising from the use of this tool. Use at your own risk. See [LICENSE](../../LICENSE) for full terms.

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
| poppler | Optional but recommended. Enables PDF ingestion via `pdftotext` / `pdfinfo`. Install with `brew install poppler` (macOS) or `apt install poppler-utils` (Debian/Ubuntu). Without poppler, PDFs in `raw-sources/` are silently skipped. |
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

1. Create a new Vault in Obsidian (e.g., `~/kioku-vault/main`)
2. Create a Private repository on GitHub (e.g., `kioku-vault`)
3. In the Vault directory: `git init && git remote add origin ...` (or `gh repo create --private --source=. --push`)

This step is not automated by KIOKU scripts. GitHub authentication (gh CLI / SSH keys) depends on your environment.

#### 2. Set the environment variable

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku-vault/main"
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
git clone git@github.com:<USERNAME>/kioku-vault.git ~/kioku-vault/main
# Open ~/kioku-vault/main/ as a Vault in Obsidian
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

Nine tools provided:

| Tool | Purpose |
|---|---|
| `kioku_search` | Wiki search (delegates to qmd CLI; falls back to a simple Node grep when qmd is unavailable) |
| `kioku_read` | Return the contents of `wiki/<path>.md` |
| `kioku_list` | Walk the `wiki/` directory tree |
| `kioku_write_note` (recommended) | Append a memo to `session-logs/`; the next auto-ingest cycle structures it into `wiki/` |
| `kioku_write_wiki` (advanced) | Write directly into `wiki/` with template + frontmatter auto-injection |
| `kioku_delete` | Move a page to `wiki/.archive/` (recoverable; `wiki/index.md` cannot be deleted) |
| `kioku_ingest_document` (feature 2.4) | **Unified ingest router** for local documents under `raw-sources/`. Dispatches by extension: `.pdf` / `.md` → PDF handler, `.epub` → EPUB handler (yauzl + 8-layer defense + readability → chapter Markdown chunks), `.docx` → DOCX handler (mammoth + yauzl + XXE pre-scan → single Markdown chunk). Image / OLE embedded content is skipped for safety (MVP) |
| `kioku_ingest_pdf` (feature 2.1, deprecated alias) | Deprecated alias for `kioku_ingest_document` restricted to `.pdf` / `.md`. Retained through the v0.5 – v0.7 window, removal planned for v0.8. Prefer `kioku_ingest_document` for new integrations |
| `kioku_ingest_url` (feature 2.2) | Fetch an HTTP/HTTPS URL, extract the article body with Mozilla Readability, save Markdown + images under `raw-sources/<subdir>/fetched/`, and queue a wiki summary. PDF URLs auto-dispatch to `kioku_ingest_document` |

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

The bundle is **gitignored** (`mcp/build/`, `mcp/dist/`). To publish a new release: run `build-mcpb.sh`, then attach the resulting `.mcpb` to a new [GitHub Release](https://github.com/megaphone-tokyo/kioku/releases) of the [megaphone-tokyo/kioku](https://github.com/megaphone-tokyo/kioku) repo. End users will then download it via Option A.

The traditional install paths in step 10 still work — MCPB is purely an *additional* delivery channel for Desktop-first users.

##### Persistence & when to re-install

**Once installed, the `.mcpb` persists through reboots and Desktop restarts.** Claude Desktop auto-spawns the server when a new conversation opens — you don't need to relaunch anything manually.

Re-install only in these cases:

| Trigger | Action |
|---|---|
| Moved your Obsidian Vault directory | Re-run the install (the dialog will re-ask for Vault directory) OR edit `~/Library/Application Support/Claude/claude_desktop_config.json` manually |
| New `.mcpb` version released | Download the new `.mcpb` and drag-install; Desktop replaces the existing extension in place |
| Uninstalled via Settings → Connectors by accident | Drag the same `.mcpb` back in |

Unlike § 10, MCPB is self-contained — **moving this source repo, switching Node versions, or updating `@modelcontextprotocol/sdk` do NOT affect an already-installed `.mcpb`** (the bundle ships its own dependencies and launches via Desktop's built-in Node runtime).

> ⚠️ **After installing or updating a `.mcpb`, fully quit Claude Desktop (⌘Q, not just close the window) and relaunch.** Otherwise the previously-spawned MCP server process keeps serving cached code in memory — your new tool definitions will appear, but behavioral changes inside the server (bug fixes, validation updates, etc.) won't take effect until the process is recreated.

##### Tips — using kioku on Claude Desktop

Unlike Claude Code (which auto-logs every session via the `session-logger.mjs` hook), **Claude Desktop has no hook system — your conversations are NOT automatically captured into the Vault**. You must explicitly ask Claude to save each thing you want to remember.

Phrases that trigger saves (Claude picks the right tool from the tool descriptions):

| You say | Tool invoked | Destination |
|---|---|---|
| "save this to my wiki" / "remember this" / "メモして" | `kioku_write_note` | `session-logs/` → structured into `wiki/` by the next auto-ingest cycle |
| "create this wiki page now" / "immediately reflect this" / "すぐ Wiki に作って" | `kioku_write_wiki` | `wiki/` directly (immediate, template applied, best-effort wikilink integrity) |

Practical habit: at the end of a meaningful conversation segment, ask Claude something like **"今の話をまとめてメモしておいて"** or **"この設計判断を記録して"**. Without this nudge, your Desktop conversation stays only in Claude's chat history — not in your Obsidian Vault.

If you also use Claude Code, its conversations are captured **automatically** without any manual request (via the hook system in step 4 above). The two clients write to the same Vault — your "second brain" accumulates knowledge from both.

<br>

## Directory Structure

```
kioku/
├── README.md                        ← This file
├── context/                         ← Current implementation (INDEX + per-feature docs)
├── handoff/                         ← Handoff notes for next session
├── plan/
│   ├── user/                      ← User's design instructions
│   └── claude/                      ← Claude's implementation specs
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
| `OBSIDIAN_VAULT` | none (required) | Vault root. auto-ingest/lint fall back to `${HOME}/kioku-vault/main` |
| `KIOKU_DRY_RUN` | `0` | `1` to skip `claude -p` calls (path verification only) |
| `KIOKU_NO_LOG` | unset | `1` to suppress session-logger.mjs (prevents recursive logging from cron subprocesses) |
| `KIOKU_DEBUG` | unset | `1` to emit debug info to stderr and `session-logs/.claude-brain/errors.log` |
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
- [ ] **Git sync error visibility** — Log `git push` failures to `session-logs/.claude-brain/git-sync.log` and surface warnings in auto-ingest

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

### 2026-07-09 — v0.11.0: "Your memory favors your newest interests, and the health check finishes in 0.1 seconds" — internal hardening 6 件 + recency decay

v0.11.0 ships **recency decay (検索の時間減衰) + internal hardening 6 件** — v0.10.0 (Sprint 5.5) で入った「使うほど賢くなる検索」(session-logs 学習) が **新しい関心を優先** するようになり、「自分の KIOKU は健康?」が **0.1 秒** で分かり、hook の **静かな失敗に気づける** ようになる。

v0.10.0 の reliability + intelligence 2 軸をそのまま深掘りする進化 — intelligence 側は時間減衰で「今の関心」に追従し、reliability 側は見えない失敗の可視化と SSOT 統合で土台を固める。

- **検索の時間減衰 (recency decay)** ("検索が古い関心に引きずられない"):
  - session-logs 学習 (v0.10.0 の Source 8) に **半減期 14 日の指数減衰** を追加 — 古い高頻度の関心より、新しい関心が上位に
  - `KIOKU_DQ_HALFLIFE_DAYS` 環境変数で半減期を調整可
  - opt-out (`.kioku-discoverqueries-opt-out`) とプライバシー契約は従来のまま不変
- **doctor --quick** ("自分の KIOKU は健康? が 0.1 秒で分かる"):
  - `bash scripts/doctor.sh --quick` — 3 項目 (直近セッションログの有無 / wiki の中身 / MCP 登録) を **0.1 秒未満** で確認
  - フル診断 (38 項目) は従来どおり flag なし、`--json` 併用可
- **install script 階層化** — `scripts/install/user/` (ユーザーが触る 3 本) と `scripts/install/internal/` (内部用 7 本) に整理。旧 path は `[DEPRECATED]` 案内付きの互換 shim を 2 release 維持、ワンライナー install の公開 URL (`scripts/install.sh`) は不変
- **Mode gate** — Claude Code 環境で手動 hook install しようとすると `/plugin install` を案内 (`--force` で override 可)
- **Hook silent failure の可視化 + 内部堅牢化**:
  - hook の静かな失敗 (空の応答 / 変換拒否 / ファイル競合) を全てログ記録 (masking 経由) + doctor 診断 + セッション開始時の通知で可視化 — 秘匿情報がログに漏れない設計はここでも維持
  - masking ルール (21 パターン) と検証ロジックを共有リテラル構造に統合、drift を機械検出する parity test を新設
  - vault path 検証を 12 script の個別実装から 1 ライブラリに SSOT 統合
- **Tests** — full test suite exit 0 (doctor 89 / install-hierarchy 58 / mask-parity 7 assertion 他)、8 PR + branch 横断の統合レビューで Critical 0
- [Release v0.11.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.11.0)

### 2026-05-19 — v0.10.0: "Your auto-ingest never fails silently, and search learns from your own sessions" — Sprint 5 + 5.5 完走 (reliability + intelligence の 2 軸進化)

v0.10.0 ships **Sprint 5 (axis A) + Sprint 5.5 (axis B) 全完走** — v0.9.0 (Sprint 4) で「使いたい時に使える体験」が 4 軸揃った上で、v0.10.0 は **基盤の信頼性と検索の知能を 2 軸** で底上げする。「自動取り込みが network 一時失敗で静かに止まらない」「検索 query が自分の過去 session から自動で学習して賢くなる」 — この 2 つを reliability + intelligence の bundle minor release として land。

KIOKU positioning に **reliability (auto-ingest 自己回復) + intelligence (discoverQueries 自動学習)** の 2 軸が加わる。Sprint 4 (v0.9.0) の 4 pillar narrative の上に、基盤を強くする 2 軸進化。

- **Sprint 5 axis A — auto-ingest pipeline reliability** ("取り込みが静かに失敗しない"):
  - `hooks/auto-ingest-retry.mjs` — auto-ingest 失敗を **retry queue** で 3 回 exponential backoff + persistent queue、次回起動時 resume
  - **classify** — 失敗を category 分類 (network / transient / permanent) して recovery 戦略を分岐
  - **manual review queue** — 自動回復不能な item を user が後から確認できる queue へ退避
  - **credential masking** — retry log に token / password が残らないよう `applyMasks` SSOT で redact
  - `scripts/doctor.sh` **`check_auto_ingest_state`** — queue 残件 / 最終成功時刻 / 失敗 category を read-only diagnostic
  - LEARN#8b N=3 mandatory extract pattern 達成
- **Sprint 5.5 axis B — discoverQueries 自動学習** ("検索が自分の会話から自動で賢くなる"):
  - `mcp/lib/discoverqueries-learning.mjs` — `discoverQueries` に **session-logs/ scan = 8th source** (weight 2.8、既存 7 source 中最高) を additive 統合、過去 session から query を dynamic 学習
  - **privacy contract 3 axis** — (1) masking SSOT `applyMasks` で sensitive content を pin (2) `.kioku-discoverqueries-opt-out` で opt-out (3) `.kioku-discoverqueries-usage.json` 64KB FIFO rotate で usage log を bounded に
  - `scripts/doctor.sh` **`check_discoverqueries_state`** — 3 axis (learning 有効性 / opt-out / usage log) を read-only diagnostic
  - LEARN#8b N=4 reinforcement (mockSessionLogScan + readUsageLog)
- **Hardened 設計契約 2 axis 通底** — credential masking SSOT (`applyMasks`) を auto-ingest retry log と discoverQueries usage log の両方で再利用、秘密を共有しても漏れない契約を 2 軸横断で維持
- **Tests** — Sprint 5 (auto-ingest-retry .mjs/.sh + auto-ingest-diagnostic + doctor) + Sprint 5.5 (discoverqueries-learning + discoverqueries-privacy + discoverqueries-diagnostic) 全 BLUE-* green、Sprint 4 累計 regression なし
- **subagent-driven N=29-34 cycle** — Sprint 5 (N=29-31) + Sprint 5.5 (N=32-34)、axis A+B 各 PR A/B/C の N=3 cycle 簡略形 × 2
- [Release v0.10.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.10.0) — `kioku-wiki-0.10.0.mcpb` attached

### 2026-05-15 — v0.9.0: "Open your wiki in a browser, search with Claude, even from your phone" — Sprint 4 完走 (4 pillar: Shell + Search + Mobile + Sync polish)

v0.9.0 ships **Sprint 4 全 phase 完走** — Sprint 3 (v0.8.0 Visualizer β) で「過去が見える」が揃った上で、Sprint 4 は **「使いたい時に使える体験」を 4 軸** で揃える。「Obsidian を起動せずブラウザで Wiki を一望」「ブラウザで keyword 検索 → Claude で深掘り」「スマホで Wiki を読める」「Git push が静かに失敗しない」 — この 4 つの疑問に 3 日間 (5/13–5/15) で 4 phase land。

KIOKU positioning が **"Hardened LLM Wiki for Professionals + Claude-augmented Search + Mobile responsive + Sync polished"** の 4 pillar narrative に確立。Path C+β progress 70% → 100% 達成、Sprint 4 全 cycle 完走 marker。

- **Phase 1 (5/13) — Web UI shell + Bases dashboard renderer** ("Obsidian なしで Wiki を一望"):
  - `kioku_generate_viz mode=shell` で **8-tab self-contained HTML** を出力 ([Dashboard] [Overview] [Timeline] [Diff] [Lineage] [Search] [Navigation] [Wikilink])
  - **Bases dashboard renderer** — `wiki/meta/*.base` を Node stdlib のみで parse、Obsidian Bases plugin の view を Obsidian なしで再現 (Hot Cache / Active Projects / Concepts / Decisions など)
  - **Path C+β 設計境界**: editor は作らない (Monaco / CodeMirror 全部 forbidden keyword)、新規ページ作成 UI なし、外部 CDN / fetch / WebSocket 0、Canvas alternative 外。Wiki を**書く**ツールは Obsidian / VS Code に任せ、KIOKU は **Markdown 解析プラットフォーム** に徹する分業
  - 8 タブの placeholder で「Phase 2 で実装予定」label — 後から追加する shape を最初に固定して、ユーザーの URL `#tab=...` を将来 stable に
- **Phase 2 (5/14) — Claude-augmented Search** ("ブラウザで keyword → Claude で深掘り"):
  - `kioku_search` に **`intent` param** + `discoverQueries` 3→7 source 拡張 (LLM が「何を探しているか」を伝えて snippet 精度向上)
  - shell **Search tab UI** — **Tier 1 offline filter** (precomputed JSON inline、HTTP サーバ不要、CSRF / port 衝突 / CORS 攻撃面 全 0)
  - **Tier 2 deep-link** "Claude で深掘り検索" — Tier 1 で足りない時 1 click で Claude session 起動、Claude が KIOKU MCP tool を叩いて深掘り回答
  - Visualizer β **URL fragment `#q=...`** → graph node highlight 連動 (shell Search tab から "view in graph" deep-link)
  - **Option C 採用 meeting** (6 role) で「localhost HTTP サーバ立てない」を意図的決定 — Hardened LLM Wiki positioning と整合、攻撃面追加なし
- **Phase 3 (5/14 夜) — Mobile responsive** ("スマホで Wiki を読みたい"):
  - shell + viz **responsive CSS + hamburger menu** + tap target 44pt+ (iOS Safari + Android Chrome real device verified)
  - **Tier 2 Mobile deep-link** — `claude://` URI scheme + 1.5s timeout + `claude.ai` web fallback (Claude モバイルアプリ未 install でも graceful degrade)
  - iOS auto-zoom 防止 16px font-size + virtual keyboard scroll 対応
  - **Mobile simplified view** (`renderMobileFallback` textContent only) + **300KB performance budget guard** — 大きな graph は scroll listview に degrade
  - CSP `navigate-to` policy で `claude://` URI scheme 許可、他 URI scheme は blocked
- **Phase 4 (5/15) — Sync polish** ("Git push が静かに失敗しない"):
  - `sync-vault.mjs` **Git push retry queue** — network 一時失敗を 3 回 exponential backoff + persistent queue で次回起動時 resume
  - **`classifyGitError`** — push failure を 5 category 分類 (network / auth / conflict / quota / unknown)、user-facing message + recovery hint
  - **`maskCredentials`** — error message から token / password / SSH key path を redact、log を共有しても秘密が漏れない
  - `doctor.sh` **sync state diagnostic** (`check_sync_state`) — `git status` + `git log @{u}..` を read-only audit、retry queue 残件を visualize
  - 44 件新規 BLUE-* test (Phase 4 累計、retry / classify / mask / doctor diagnostic + sync-diagnostic.test.sh)
- **Sprint 3 + Sprint 4 全 phase 累積 stats** — Sprint 3 (4 phase) + Sprint 4 (4 phase × 15 sub-PR) = **8 phase / ~19 sub-PR を 4 月後半～5 月中旬の 3 週間** で land、Path C+β 70% → 100% completion
- **Hardened 設計契約 4 phase 通底** — offline-first / textContent only / 外部依存ゼロ / 攻撃面追加ゼロ、を 4 phase ずっと崩さない (Phase 2 Search の Option C / Phase 3 Mobile の textContent only / Phase 4 Sync の credential masking で連続して効いた)
- **subagent-driven N=28 of 28 cycle** — Sprint 4 全 cycle で subagent-driven development pattern (LEARN#7 中規模 feature の 5 層 formula) を 4 phase × 4 cycle 連続適用、累計 N=28
- [Release v0.9.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.9.0) — `kioku-wiki-0.9.0.mcpb` attached

### 2026-05-13 — v0.8.0: "Open KIOKU and see what your memory looks like" — HTML Visualizer β (Sprint 3 完走)

v0.8.0 ships **Sprint 3 (価値の可視化) completion** — Sprint 1 (信頼性) と Sprint 2 (記憶品質) で 「自分の KIOKU は動いてる? Wiki は腐ってない?」 に答える土台ができた上で、Sprint 3 は **「自分の記憶がどう育っているか」 を 5 秒で見せる HTML Visualizer β** を提供する。Obsidian なしで開ける self-contained HTML として、`kioku_generate_viz` MCP tool が 4 view (Overview / Timeline / Diff / Lineage) を 1 ファイルに包む。

This is the first release where **KIOKU can show its value without Obsidian** — drag-and-drop the generated HTML into any browser and see your second brain breathe.

- **Overview tab (Phase 1 + 2)** — Open KIOKU and see 4 layers at a glance:
  - **Vault overview** — pages total, summaries growth (7d/30d), page type distribution
  - **Health focus** — broken wikilinks (cluster view with merge candidates) / source sha256 duplicates / warm zone (7-30 days, fresh→warm→stale gradient)
  - **Graph preview** — hot pages by inbound degree / active projects / recent decisions
  - **Action queue** — 3-5 actionable items with P0/P1/P2 priority + concrete `next_action`
- **Status banner + 5 visualizations (Phase 2)** — All pure CSS + DOM, no external chart library:
  - bar chart for page type distribution
  - sparkline for summaries growth rate (7d/30d)
  - warm zone gradient (fresh/warm/stale 3-segment bar)
  - broken wikilink cluster (target で grouped, merge candidate view)
  - source_sha256 duplicate cluster (same-source 重複 page の merge surface)
- **Lineage tab (Phase 3)** — KIOKU's distinctive view: **raw-sources → summaries → wiki pages** の 3 layer lineage graph with 5 edge types (sha256 / derived_from / filename / wikilink / time proximity). 300-node cap, best-effort hint, 1-2 hop subgraph helper. Real Vault dogfood: 184 nodes / 846 edges in 68ms.
- **Quality notes drawer (Phase 4)** — `wiki/lint-report.md` (auto-lint output) を 5 枚目の Overview card として表示。Phase 2 で 2 重 negative assert していた契約を **Phase 4 で flip** (negative → positive) — auto-lint 4 観点 (concept contradiction / concept splinter / dedicated page candidate / semantic wikilink gap) が drawer に並ぶ。`kioku_health` の 11 machine-checkable metrics と auto-lint の LLM judgment が **non-overlapping surface** で共存する。
- **§46 N=3 mandatory refactor** — `mcp/lib/wiki-walker.mjs` 抽出、3 caller (health-metrics / visualizer-data / lineage-graph) を `walkPages()` 共通 entry point に統一。LEARN#8b framework の好例。
- **Tests**: 38 Phase 4 (visualizer-data 24 + visualizer 10 + screenshot 4) + 45 Phase 3 (wiki-walker 9 + lineage-graph 7+補強 + visualizer-data 15 + mcp/visualizer 9) + 全 Node + Bash regression 全 pass。CI screenshot regression (`tests/mcp/tools-visualizer-screenshot.test.mjs`) で empty / small Vault fixture を deterministic に走らせる。
- **Real-world dogfood (PM Vault, 162 pages)** — Overview tab で broken=23 / sha256_dup=2 / warm=99、Lineage tab で 184 nodes / 846 edges、auto-lint drawer で 4 categories surface。HTML self-contained 61.5KB (external script/link/fetch 全 0)
- [Release v0.8.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.8.0) — `kioku-wiki-0.8.0.mcpb` attached

### 2026-05-08 — v0.7.5: Sprint 2 完走 — `kioku_health` 11 metrics (stretch 5 追加) + auto-lint refactor

v0.7.5 marks **Sprint 2 (記憶品質 dashboard) completion** — same-day micro cascade after v0.7.4 morning release. Where v0.7.4 shipped the **core 6 metrics** (orphan / stale / duplicate title / hot.md age / last ingest / unprocessed session-logs), v0.7.5 adds the **stretch 5 metrics** identified in the codex roadmap §「指標案」 and **refactors auto-lint** to no longer overlap with `kioku_health`'s machine-checkable surface.

- **`kioku_health` 6 → 11 metrics** — the 5 added metrics:
  - `broken_wikilink` — `[[link]]` references that don't resolve to any page in wiki/ (= orphan link)
  - `source_sha256_duplicate` — pages sharing the same `source_sha256:` frontmatter (= idempotent ingest broken or manual dup)
  - `pages_warm_zone` — pages with `updated:` between 7-30 days (= warm zone, between fresh and stale-30d)
  - `page_count_by_type` — breakdown by page type (concept / project / decision / source-summary / log / index / meta / その他)
  - `summaries_growth_rate` — `wiki/sources/*-summary.md` additions in last 7d / 30d, expressed as count/day
- **`auto-lint` LINT_PROMPT 6 → 4 観点 refactor** — `scripts/auto-lint.sh` now explicitly excludes the 11 `kioku_health` machine-checkable metrics from its observation list, leaving only **LLM judgment-required semantic patterns**:
  1. **概念の矛盾** (contradicting facts across pages, old claims overwritten by newer sources)
  2. **概念の splinter** (same concept split across multiple pages, merge candidates)
  3. **専用ページが必要な繰り返し言及概念** (mentioned repeatedly in sources/summaries but no dedicated `wiki/concepts/` page)
  4. **意味的な相互リンク欠落** (semantic gap — pages thematically related but not wikilinked; broken wikilink syntax handled by `kioku_health`)
- **Real-world dogfood (PM Vault, 155 pages)** — first run on 2026-05-08 surfaced `broken=21 / sha256_dup=2 / warm zone=99 / growth 30d=33`, immediately actionable via `next_actions` text
- **Tests**: 33 BLUE-HEALTH-* + MCP-HEALTH-* (incl. STRETCH-1..7) + 9 BLUE-DRIFT-* + 53 BLUE-LINT-PROMPT-* + 475+ existing Node + 22 Bash all green; `npm audit` clean
- [Release v0.7.5](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.5) — `kioku-wiki-0.7.5.mcpb` attached

### 2026-05-08 — v0.7.4: Sprint 2 着手 — `kioku_health` MCP tool + 6 memory health metrics

v0.7.4 launches **Sprint 2 (記憶品質 dashboard)** of the post-v0.7.1 reliability roadmap. Where Sprint 1 (v0.7.2 / v0.7.3) gave KIOKU diagnostic / drift / onboarding tools, **Sprint 2 makes KIOKU's memory itself self-aware** — does the Wiki contain orphan pages? stale notes? duplicate titles? `kioku_health` answers all of these in 5 seconds.

- **`kioku_health` (11th MCP tool)** — Claude Desktop / Claude Code can now ask "is my KIOKU memory healthy?". Returns 6 core metrics as JSON: `orphan` / `stale (>30d)` / `duplicate title` / `hot.md age` / `last ingest` / `unprocessed session-logs`. Each metric pairs with a concrete `next_actions` suggestion (e.g., "1 orphan pages → Add wikilinks or move to wiki/.archive/"). Read-only — never modifies wiki/.
- **`scripts/generate-health.mjs` standalone Node script** — `bash scripts/generate-health.mjs` writes `wiki/meta/health.md` (markdown body + JSON appendix) so the same metrics surface in the Obsidian dashboard view (`templates/wiki/meta/dashboard.base` gains a "Wiki Health" view alongside the existing 9). Use it as a CI gate, a monthly cron, or just `--dry-run` for an instant terminal report.
- **6 metrics by design rationale**:
  - `orphan` — pages with no inbound wikilinks (= disconnected memory)
  - `stale (>30d)` — frontmatter `updated:` over 30 days old (= dormant)
  - `duplicate title` — pages sharing the same H1 (= splintered concept)
  - `hot.md age` — time since last manual `wiki/hot.md` update (= short-term memory freshness)
  - `last ingest` — newest `session-logs/*.md` mtime (= ingest pipeline alive?)
  - `unprocessed session-logs` — `ingested: false` count (= auto-ingest backlog)
- **Sprint 2 stretch (planned for v0.7.5)** — `broken wikilink` / `source_sha256 duplicate` / `pages updated 7-30 days` / `Wiki page count by type` / `summaries growth rate` will land separately
- **Tests**: 23 BLUE-HEALTH-* + MCP-HEALTH-* + 9 drift (11 tools verified) + 475+ existing Node + 22 Bash suites all green. `npm audit` clean
- [Release v0.7.4](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.4) — `kioku-wiki-0.7.4.mcpb` attached

### 2026-05-07 — v0.7.3: Sprint 1 完走 marker — Mode A/B/C onboarding + doctor mode detection

v0.7.3 marks the **Sprint 1 reliability roadmap completion** (4 PRs in 8 days). The single-feature delta from v0.7.2 is Mode A/B/C onboarding gradient in Quick Start + `doctor` install-mode detection.

- **Mode A/B/C onboarding (#4)** — Quick Start now offers three install paths so users no longer forced into full install upfront:
  - **Mode A: MCP-only** — Claude Desktop / security-conscious / casual try-out (no hooks, no auto-ingest, no Git sync)
  - **Mode B: Read-only** — *planned for v0.7.x* (write/read tool separation), for enterprise / legal review / shared Vault viewers
  - **Mode C: Full memory** — existing full Manual Setup, renamed (zero regression)
- **`doctor` mode detection** — `bash scripts/doctor.sh` now emits `[mode] Current install mode: ...` derived from MCP / Hooks / cron / Git sync check results. `--json` output includes `summary.install_mode` + `summary.install_mode_detail` for tooling. 8 new BLUE-DOCTOR-MODE-* tests (44 total)
- **Sprint 1 完走 marker** — codex roadmap §「Sprint 1: 信頼性と導入」 4 PRs all landed: doctor MVP (#84) + drift test (#89) + URL test stabilization (#90) + this Mode A/B/C onboarding (#96)
- Tests: **Node 475 + Bash all suites + 44 doctor + 9 drift all green**, `npm audit` clean
- [Release v0.7.3](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.3) — `kioku-wiki-0.7.3.mcpb` attached

### 2026-05-07 — v0.7.2: Reliability Sprint — `kioku doctor` + metadata drift test + URL test stabilization

v0.7.2 ships the entire **Sprint 1** of the post-v0.7.1 reliability roadmap. Where v0.7.0 / v0.7.1 hardened the multi-agent boundary, v0.7.2 turns KIOKU's "what's broken?" surface from intuition into machine-checkable across three new diagnostic axes.

- **`kioku doctor` (PR A)** — `bash scripts/doctor.sh` runs 22 read-only checks across 7 categories (Environment / Runtime / CLI agents / Hook configs / MCP configs / Metadata parity / Dependencies). Human-readable by default, `--json` for tooling. Each `[fail]` / `[warn]` is paired with a concrete `Next action` (e.g. `bash scripts/install-mcp-client.sh --apply`). 36 BLUE-DOCTOR-* tests with temp HOME / temp Vault isolation, macOS / Linux portable (avoids BSD vs GNU `stat` divergence by design)
- **metadata drift test (PR B)** — `node --test tests/metadata-drift.test.mjs` machine-detects 3 drift categories: MCP tool registry (server.mjs ↔ manifest.json ↔ README ↔ context/14) / 5-place version parity (package.json + manifest.json + plugin.json + marketplace.json metadata + plugins[0]) / install command syntax (docs/install-guide-plugin.md `claude plugin marketplace add` syntax + identifier matches `marketplace.json` `name`). Codifies the §44 install-syntax-drift incident (4/28) into a continuous regression guard. 9 BLUE-DRIFT-* tests
- **URL test stabilization (PR C)** — Daily `node --test ...` no longer hangs minutes on URL/fetch tests. `tests/run-quick-suite.sh` (60s budget, `KIOKU_SKIP_NETWORKISH_TESTS=1` forced, hooks/ + mcp/ only) is the new contributor default; `tests/run-full-suite.sh` (FAIL_LOG aggregation, network included) is the release-time gate. 10 URL test files now share a `{ timeout, skip }` pattern with explicit fixture-server cleanup. Measured: **quick suite 9.8s on Mac mini** (target <60s)
- **Side-finding fixes (bundled)** — `mcp/package-lock.json` version field bumped 0.5.0 → 0.7.2 (long-stale lock metadata, future drift test 6th place candidate). `tests/post-release-sync.test.sh` PRS-S13 gains a linked-worktree skip guard (`[[ -f "${REPO_ROOT}/.git" ]]` detects pointer-file `.git` and skips dynamic dry-run output match)
- Tests: **Node 475 + Bash 22 suites + 36 doctor + 9 drift + 27 post-release-sync all green**, `npm audit` clean
- [Release v0.7.2](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.2) — `kioku-wiki-0.7.2.mcpb` attached

### 2026-04-30 — v0.7.1: Polish — `agent:` frontmatter + 5 hardening + workflow codification

v0.7.1 polishes the multi-agent narrative landed in v0.7.0: every session log now carries its agent identity in the frontmatter, five quiet hardening fixes (lock TOCTOU, realpath fallback, exit-reason masking, transcript-path boundary, listener accumulation), and the workflow rules gain bidirectional-drift codification.

- **`agent:` frontmatter field (§41)** — `buildFrontmatter` now emits `agent: <claude|gemini|codex>` immediately after `type: session-log`. Previously, Gemini and Codex session logs were indistinguishable by frontmatter alone (only `session_id` namespace was independent). With v0.7.1, indexing and filtering across multi-agent vaults work with a single grep. Verified end-to-end on 2026-04-30 against fresh codex (`019ddce8-...`) and gemini (`f8b1aeb3-...`) sessions
- **5 hardening fixes (§33-36, §38)** in `hooks/session-logger-core.mjs` + `hooks/adapters/_common.mjs`:
  - **§33 INDEX-LOCK-TOCTOU-RACE** — lock acquisition now uses 2-stage defense: (a) PID alive check (`process.kill(pid, 0)`) before stealing a stale-mtime lock, (b) post-acquire content re-verify with jitter retry to detect race-stolen locks
  - **§34 BUILD-CONTEXT-REALPATH-FALLBACK** — `realpath` failure (EROFS / ENOENT / EACCES on dangling symlink) now falls back to literal path comparison instead of throwing. `KIOKU_DEBUG=1` warns to stderr; production stays silent
  - **§35 EXIT-REASON-MASK-COVERAGE** — `sessionEnd.reason` now flows through `applyMasks()` + `yamlSafeValue()` before being written to frontmatter. Defense-in-depth against future vendor schema drift where reason might become free-form
  - **§36 TRANSCRIPT-PATH-VAULT-BOUNDARY** — new `assertTranscriptInRoot(agent, path)` allowlists `~/.{claude,gemini,codex}/{projects,chats,sessions}/`, rejects vault-external paths and symlink escapes via realpath. All 3 adapters wire it before passing `transcript_path` to core
  - **§38 COMMON-MJS-GLOBAL-LISTENER-ACCUMULATION** — `safeMain` listener registration is now gated by a module-scope flag, eliminating `MaxListenersExceededWarning` in test harnesses that import multiple adapters
- **Install path hot fix (§44, applied during the v0.7.0 → v0.7.1 window)** — `marketplace.json` `name` renamed `kioku-marketplace` → `megaphone-tokyo` so the docs syntax `claude plugin install kioku@megaphone-tokyo` works as documented. All 10 README + `docs/install-guide-plugin.md` updated to Claude Code v2.1.89 marketplace syntax (`claude plugin marketplace add ...` instead of legacy `claude marketplace add ...`)
- **Codex per-turn commit doc (§37)** — `docs/install-guide-multi-agent.{md,ja.md}` Codex section gains a "Note on per-turn commits" call-out (Hook port users only): SessionEnd absent → Stop event git-sync emulation → bounded commit count per session, with disable instructions
- **Two new code-style rules (§39 LEARN#13 / §40 LEARN#14)** — `.claude/rules/code-style.md`: regex literal control-char escape mandate (U+2028/U+2029/U+200B/U+FEFF must use `\uXXXX`) and ESM entry gate pattern (`isEntry()` for adapter modules to avoid stdin-hang on test imports)
- **Workflow codification (parent-only)** — LEARN#10 reverse drift codified: PM mental-model drift can run *either* direction (phantom file paths *or* tasks already merged). `git log -10 origin/main --oneline` is now a mandatory PM precheck before creating delegation handoffs, paired with the existing `origin/main..main` empty check (LEARN#12 Rule 2). Caught duplicate-delegation in real-time on 2026-04-30
- **Verifier script graduation** — `scripts/verify-multi-agent-e2e.sh` Step 6 agent-field check graduates from informational to a fail signal (`exit 1`) now that §41 ships
- Tests: **Node 155/155 hook suites + 389 non-hook + Bash install-hooks all green**, `npm audit` clean
- [Release v0.7.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.1) — `kioku-wiki-0.7.1.mcpb` attached

### 2026-04-28 — v0.7.0: Multi-agent complete — Hook port for Gemini / Codex + automatic session log parity + Visualizer α

v0.7.0 closes the narrative-implementation gap that v0.6.0 opened: where v0.6.0 made KIOKU **discoverable** across non-Claude agents (skill symlinks), v0.7.0 makes KIOKU **actively work** across them — automatic session logging, hot-cache pipeline, and per-agent install scripts. Visualizer α also ships its first user-visible MCP tool.

- **Hook port for Gemini / Codex (Q2)** — `hooks/session-logger.mjs` (591 lines, monolithic) refactored into `hooks/session-logger-core.mjs` (agent-agnostic core) + `hooks/adapters/{claude,gemini,codex}.mjs` (per-agent translators) + `hooks/adapters/_common.mjs` (`safeMain` exit-0 contract + `escapeForSystemMessage` XSS defense). `scripts/install-hooks-{gemini,codex}.sh` give one-command install per agent. **Result**: a Gemini or Codex session now produces session logs at `$OBSIDIAN_VAULT/session-logs/` byte-equivalent to Claude's, with masking applied through the same pipeline
- **Multi-agent MCP setup docs (Q1)** — `docs/install-guide-multi-agent.md` (EN) + `.ja.md` (JA) document the per-agent MCP config (`~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.config/opencode/opencode.json`) with verification commands and `Verification status: Unverified in our environment` banners on each agent section (LEARN#10 transparency, Q1 PR #54)
- **Self-recursion guard agent-aware (§43 fix)** — `buildContext({ agent })` now narrows the cwd-in-vault no-op rule to `agent === 'claude'` only. Pre-fix, running `cd $OBSIDIAN_VAULT && codex` silently dropped session logs because the guard (originally for auto-ingest re-entrance) fired for all agents. Post-fix, Gemini and Codex log normally even when started from inside the vault. Caught and fixed during pre-release dogfood (PR #60)
- **Visualizer α (V-2 + V-3/V-4)** — `kioku_generate_viz` MCP tool generates a static HTML page (`<vault>/wiki/<title>.html`) with embedded snapshot JSON, sanitized via `safeJsonForScript` (escapes `</`, U+2028/U+2029) + DOM-built rendering (zero `innerHTML`). The Timeline Player and Diff Viewer surfaces from V-1 lib (already in v0.6) become user-callable
- **`verify-multi-agent-e2e.sh` helper** — Interactive 6-step verifier (`bash scripts/verify-multi-agent-e2e.sh --agent=<gemini|codex>`) walks through CLI install check → hook apply → user-driven session → session-log inspection (frontmatter agent tag + masking spot check + Codex per-turn git-sync count). Ships in this release for users to confirm their setup beyond the `.mcpb` install
- **Manifest tools array reconciled (§32)** — `mcp/manifest.json` now lists all 10 MCP tools (was 8; `kioku_ingest_document` and `kioku_generate_viz` were missing since v0.5.0/v0.6.0). `long_description` updated to "ten tools". Catches via 製作 Claude's LEARN#4 precheck during Q1 delivery
- **README branding fix** — Public READMEs (10 languages) had `claude-brain` (parent monorepo internal codename) leaking through into project descriptions, command paths (`tools/claude-brain/scripts/...`), and vault example names. All references corrected to `KIOKU` / `kioku-vault` / repo-root paths (kioku PR #30)
- **Pre-release dogfood verify** — Gemini (2026-04-24) and Codex (2026-04-27 + 28) verified end-to-end on RYU's Mac mini before tag publication. §43 caught and fixed in the same release window. Details: `handoff/post-release-v0-7-0.md` Pre-release verification log
- **Deferred for v0.7.1+** — V-1 hotfix (HIGH 4 + Medium 9 from V-1 review), §41 (`agent:` frontmatter field), §42 (Gemini adapter output duplication), §34 (`buildContext` realpath fallback), `SECURITY.ja.md` remaining 3 sections — all tracked in `handoff/open-issues.md`
- Tests: **Node 136/136 hook suites + Bash all green**, `npm audit` clean
- [Release v0.7.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.7.0) — `kioku-wiki-0.7.0.mcpb` attached

### 2026-04-24 — v0.6.0: Ecosystem expansion — multi-agent + plugin marketplace + Bases dashboard + delta tracking + security hardening

v0.6.0 lands Phase C in one shot: distribution channels (Claude Code plugin + multi-agent skills), Obsidian-native dashboards, silent-regression-proof ingest, and security policy upgrades. Visualizer foundations are also land-ready for v0.7.

- **Multi-agent cross-platform (C-1)** — `scripts/setup-multi-agent.sh` symlinks KIOKU skills into Codex CLI / OpenCode / Gemini CLI. 19/19 Bash assertions (SMA-1..8)
- **Claude Code plugin marketplace (C-2)** — `claude plugin marketplace add megaphone-tokyo/kioku && claude plugin install kioku@megaphone-tokyo`. `docs/install-guide-plugin.md` compares 3 install paths
- **Raw MD sha256 delta tracking (C-3)** — User-placed `raw-sources/<subdir>/*.md` files now participate in sha256-based delta detection. 82/82 auto-ingest assertions (new F23-F27)
- **Obsidian Bases dashboard (C-4)** — `templates/wiki/meta/dashboard.base` ships 9 views tailored to KIOKU's wiki structure
- **Visualizer foundation (V-1, preparing v0.7)** — `mcp/lib/git-history.mjs` + `mcp/lib/wiki-snapshot.mjs` with 14/14 Node assertions. No user-facing surface yet
- **Security policy upgrade (C-5a)** — `SECURITY.md` gains CVE Classification / Safe Harbor / Coordinated Disclosure Timeline / Out of Scope. `SECURITY.ja.md` partial i18n parity (4/7 sections)
- **Community channel pivot** — Dedicated Discord dropped, GitHub Discussions will be the canonical channel
- **Organizational learnings** — LEARN#10 (PM handoff script verify mandatory) added to workflow rules
- **Deferred for v0.7+** — Visualizer HTML UI (V-2..V-5), LP β narrative, GitHub Discussions enable, SECURITY.ja remaining 3 sections
- Tests: **Node 264/264 + Bash 400+/400+ assertions green**
- [Release v0.6.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.6.0) — `kioku-wiki-0.6.0.mcpb` attached (~9 MB)

### 2026-04-23 — v0.5.1: Hot cache + PostCompact hook + opt-in Stop prompt

- **Hot cache pattern** — New `wiki/hot.md` (<=500 words, hard cap 4000 chars) is auto-injected at **SessionStart** and re-injected after **PostCompact** (context compaction), so the LLM retains short-term working context across sessions and compactions. Inspired by the claude-obsidian UX pattern
- **PostCompact hook** — `install-hooks.sh` now wires a 6th event (`PostCompact`) that re-injects hot.md only (index.md is already in context after compaction, so it is skipped to avoid token bloat)
- **Opt-in Stop prompt** (`KIOKU_HOT_AUTO_PROMPT=1`) — When explicitly set, session end triggers an update suggestion for hot.md. **Default OFF** — hot.md is Git-synced and has a stricter security boundary than session-logs, so auto-prompting requires explicit user consent
- **Security boundary maintained** — hot.md flows through `applyMasks()` (API key / token pattern masking) before injection, is in the scan-secrets.sh walk target, rejects symlink escape via `realpath` (vault-external paths rejected), and truncates at 4000 chars with a WARN log
- **Claude Code v2 hook schema alignment (4 hotfixes)** — Claude Code v2 uses different output schemas per event: `hookSpecificOutput` is supported only for `PreToolUse` / `UserPromptSubmit` / `PostToolUse`; `PostCompact` and `Stop` must use top-level `systemMessage`. The legacy v1 flat `{additionalContext}` is silently discarded in v2. hotfixes 1-4 migrate all hook output to the correct per-event schema
- Tests: **47 Node assertions** (HOT-1..9d + HOT-V1/V2 + session-logger regression + injector H1-H5) **+ 488 Bash assertions** (IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 15 existing suites), all green
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` attached (9.2 MB)

### 2026-04-23 — v0.5.0: Feature 2.4 — PDF / MD / EPUB / DOCX unified ingest router

- **Phase 1** — `kioku_ingest_document` router: a unified MCP tool that dispatches by file extension (`.pdf` / `.md` / `.epub` / `.docx`) to the correct handler. Existing `kioku_ingest_pdf` becomes a deprecation alias retained for the v0.5 – v0.7 window; removal planned for v0.8
- **Phase 2** — EPUB ingestion: safe extraction via yauzl with 8-layer defense (zip-slip / symlink / cumulative size cap / entry count cap / NFKC filename / nested ZIP skip / XXE pre-scan / XHTML script sanitize). Spine-ordered chapters are converted to Markdown chunks (`readability-extract` + `turndown`), stored at `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`; multi-chapter EPUBs also get an `-index.md`. LLM summaries flow through the auto-ingest cron asynchronously
- **Phase 3** — DOCX ingestion (MVP): a `mammoth + yauzl` two-layer architecture (mammoth's internal jszip attack surface is pre-guarded by yauzl's 8-layer defense). `word/document.xml` / `docProps/core.xml` go through an XXE pre-scan (`assertNoDoctype`). Images (VULN-D004/D007) and OLE embedded content (VULN-D006) are deferred — MVP extracts body text + headings only. Metadata is enclosed in a `--- DOCX METADATA ---` fence with an **untrusted** annotation to delimit prompt injection against downstream LLM summarization
- **Pre-release hotfix** — Fixed the argv regex in `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` to be Unicode-aware (`\p{L}\p{N}`); the previous `\w` (ASCII only) silently skipped Japanese / Chinese filenames like `論文.docx` / `日本語.epub` in the auto-ingest cron path. EPUB was in this latent regression since v0.4.0 and is fixed retroactively (LEARN#6 cross-boundary drift). Additionally, `meta` / `base` / `link` were added to `html-sanitize`'s `DANGEROUS_TAGS` as defense-in-depth for future EPUB consumer paths
- **Known issue (non-applicable)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium) targets the **XMLBuilder** API (XML writer). This codebase uses only **XMLParser** (XML reader) in `mcp/lib/xml-safe.mjs`, so the vulnerability is not exploitable. The dependency will be upgraded to `fast-xml-parser@^5.7.0` in **v0.5.1** to clear the dependabot alert
- Tests: **158 Bash assertions + full Node suite green** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30). `npm audit` reports **0 vulnerabilities** on runtime dependencies; red-hacker + blue-hacker parallel `/security-review` reports **0 HIGH/CRITICAL** findings
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` attached (9.2 MB)

### 2026-04-21 — v0.4.0: Tier A (security + ops) + Tier B (cleanness) overhaul

- **A#1** — Upgraded `@mozilla/readability` 0.5 → 0.6 (ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7) mitigated; 144 production dependencies pass `npm audit` clean)
- **A#2** — Added `git symbolic-ref -q HEAD` guard to `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd, preventing runaway commits when the Vault is in a detached-HEAD state (5-day drift observed on one machine before the fix)
- **A#3** — Refactored `withLock` (shrunk hold time from minutes to seconds), removed the `skipLock` API entirely, and added orphan-PDF cleanup
- **B#1** — Hook layer re-audit (`session-logger.mjs`): fixed 3 MEDIUM findings (invisible-character bypass of masking, YAML injection in frontmatter, `KIOKU_NO_LOG` strict-equality drift)
- **B#2** — Formalized cron/setup guard parity as `tests/cron-guard-parity.test.sh` (17 assertions) to enforce the Category-A / Category-B env-override conventions
- **B#3** — `sync-to-app.sh` cross-machine race prevented by `check_github_side_lock` (α guard, 120s default window, configurable via `KIOKU_SYNC_LOCK_MAX_AGE`); regression locked in by `tests/sync-to-app.test.sh` (11 assertions)
- **B#8** — README i18n parity: §10 MCP / §11 MCPB / Changelog sections added to all 8 non-en/ja READMEs (+1384 lines)
- Tests: **299 Node tests** + **15 Bash suites / 415 assertions**, all green
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` attached

### 2026-04-17 — Phase N: MCPB bundle for Claude Desktop
- New `mcp/manifest.json` (MCPB v0.4) and `scripts/build-mcpb.sh` produce `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 MB)
- Claude Desktop users can install the MCP server with a single drag-and-drop; `OBSIDIAN_VAULT` is configured via the install dialog's directory picker (no Node toolchain required on the user's machine — Desktop's bundled runtime is used)
- Phase M's manual install path (`setup-mcp.sh` + `install-mcp-client.sh`) is unchanged; MCPB is an additional delivery channel for Desktop-first users
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

This project is licensed under the MIT License. See [LICENSE](../../LICENSE) for details.

As noted in the "Important Notes" section above, this software is provided "as is" without warranty of any kind.

<br>

## References

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — The original concept this project implements
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Official Hook system documentation
- [Obsidian](https://obsidian.md/) — The knowledge management app used as the Wiki viewer
- [qmd](https://github.com/tobi/qmd) — Local search engine for Markdown (BM25 + vector search)

<br>

## Author

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Building things with code and AI. Freelance engineer, 10 years in. Frontend-focused, lately co-developing with Claude as my main workflow.

[Follow me on X](https://x.com/megaphone_tokyo)
