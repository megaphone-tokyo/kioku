# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| main branch (latest) | Yes |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via **GitHub Security Advisories**:

1. Go to the [Security tab](../../security/advisories) of this repository
2. Click "Report a vulnerability"
3. Fill in the details using the template below

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Depends on severity (critical: ASAP, high: 1 week, medium: 2 weeks)

## Security Design

claude-brain is a Hook system that accesses **all Claude Code session I/O**. This section documents the security architecture.

### Threat Model

| Threat | Mitigation |
|---|---|
| API keys/tokens leaking into session logs | Regex masking (`MASK_RULES` in `session-logger.mjs`) covers Anthropic, OpenAI, GitHub, AWS, Slack, Vercel, npm, Stripe, Supabase, Firebase/GCP, Azure, Bearer/Basic auth, URL credentials, PEM keys |
| Session logs pushed to GitHub | `.gitignore` excludes `session-logs/`. SessionEnd git hook verifies `.gitignore` integrity before committing |
| Hook script tampering | `install-hooks.sh --apply` sets `chmod 755` on hook scripts. Only owner can write |
| Shell/XML/JSON injection via OBSIDIAN_VAULT | `validate_vault_path()` rejects shell metacharacters, JSON control characters, and XML special characters |
| Prompt injection via session logs in auto-ingest | `claude -p` runs with `--allowedTools Write,Read,Edit` only (no Bash). LLM cannot execute shell commands |
| Recursive logging (subprocess logs itself) | `KIOKU_NO_LOG=1` env var + cwd-in-vault check (double guard) |
| qmd MCP exposing data on LAN | Binds to `127.0.0.1` only. Logs written to `~/.local/log/` (not `/tmp/`) |
| Insecure file permissions on shared systems | `session-logs/` created with `0o700`, files with `0o600`. `setup-vault.sh` sets `umask 077` |
| session-logs searchable via qmd | `brain-logs` collection is opt-in only (`setup-qmd.sh --include-logs`) |
| Non-portable binary checks | PATH binary ownership check uses POSIX `ls -ln \| awk` (works on macOS and Linux) |
| **SSRF via attacker-controlled URL** (feature 2.2, `kioku_ingest_url`) | Two-stage guard in `mcp/lib/url-security.mjs` + `mcp/lib/url-fetch.mjs`: pre-resolve rejects localhost / RFC1918 / link-local (169.254/16) / AWS/GCP metadata / IPv4-mapped IPv6 / decimal-hex-octal IP literals / credentials in URL; then resolve-then-pin via custom DNS lookup so redirects and DNS rebinding cannot slip in |
| **Scheme downgrade on redirect** (feature 2.2) | HTTPS → HTTP redirect is explicitly detected and rejected (`url-fetch.mjs`) |
| **robots.txt bypass** (feature 2.2) | `mcp/lib/robots-check.mjs` enforced twice (MCP tool entry + `extractAndSaveUrl` inner). Opt-out requires explicit `KIOKU_URL_IGNORE_ROBOTS=1` with a startup-time stderr WARN |
| **HTML prompt injection from fetched pages** (feature 2.2) | Mozilla Readability extracts visible body only (strips scripts / styles / noscript). LLM fallback runs `claude -p --allowedTools Write(<absCacheDir>/llm-fb-*.md)` with chdir to `absCacheDir` and a minimal child env (see **Child Process Env Allowlist** below) |
| **Attacker HTML cached to `.cache/html/`** (feature 2.2) | Git-ignored (`.cache/` + `.cache/html/` in `templates/vault/.gitignore`); directory `0o700` / file `0o600`; filename passes through `urlToFilename` sanitizer with `SAFE_PATH_RE` semantics before realpath join |
| **Attacker images inflate Vault repo** (feature 2.2) | `raw-sources/**/fetched/media/` is git-ignored; images remain local for Obsidian display but never enter the Git history. MIME whitelist (jpeg/png/webp/gif); SVG and 1×1 tracking pixels are skipped; per-image 20 MB cap |
| **Child env leaking SSRF / robots bypass flags** (feature 2.2, HIGH-d1 fix) | `mcp/lib/child-env.mjs` uses exact-match allowlist. `KIOKU_URL_*`, `KIOKU_EXTRACT_*`, `KIOKU_ALLOW_EXTRACT_*` are **not** propagated. Only internal flags (`KIOKU_NO_LOG`, `KIOKU_MCP_CHILD`, `KIOKU_DEBUG`, `KIOKU_LLM_FB_*`) reach the child MCP / `claude -p` process |
| **Frontmatter secret leak via HTML meta tags** (feature 2.2) | `applyMasks` is applied to body, `title`, `tags`, `byline`, `site_name`, `source_type`, `og_image`, `published_time`, `source_final_url`, `source_host`, and `warnings` before serialization (`url-extract.mjs#buildFrontmatterObject`) |
| **MCP error messages leaking internal IPs / URLs** (feature 2.2) | `mapFetchErrorAndThrow` in `ingest-url.mjs` and `url-extract-cli.mjs` return only error codes (`dns_private`, `url_scheme`, etc.) for security-sensitive codes; attacker-controlled strings never reach Claude context or cron logs |

### File Permission Model

| Path | Permission | Set by |
|---|---|---|
| `session-logs/` (directory) | `0o700` | `session-logger.mjs` (`mkdir`) |
| `session-logs/*.md` (log files) | `0o600` | `session-logger.mjs` (`writeFile` with `flag: 'wx'`) |
| `session-logs/.claude-brain/` | `0o700` | `session-logger.mjs` (`mkdir`) |
| `session-logs/.claude-brain/index.json` | `0o600` | `session-logger.mjs` (`writeFile`) |
| `hooks/session-logger.mjs` | `0o755` | `install-hooks.sh --apply` |
| `hooks/wiki-context-injector.mjs` | `0o755` | `install-hooks.sh --apply` |
| Vault directories (`wiki/`, etc.) | `umask 077` | `setup-vault.sh` |

### Adding New Token Patterns

When you start using a new cloud service, add its token pattern to both files:

1. **`hooks/session-logger.mjs`** — `MASK_RULES` array (JavaScript regex)
2. **`scripts/scan-secrets.sh`** — `PATTERNS` array (ERE regex)

The two arrays must stay in sync. `scan-secrets.sh` detects tokens that `session-logger.mjs` failed to mask.

### Security Review History

Comprehensive security reviews are documented in [`security-review/`](security-review/):

- **2026-04-16 (Round 1)**: 14 vulnerabilities found (1 critical, 6 high, 4 medium, 2 low). All fixed.
- **2026-04-16 (Round 2)**: 9 new findings (0 critical, 0 high, 3 medium, 6 low). 7 fixed, 2 accepted.
- **2026-04-16 (Round 3 — OSS readiness)**: 15 findings with OSS distribution as threat model. 8 fixed (incl. LICENSE, timezone, umask), 7 accepted.
- **2026-04-16 (Round 4 — Red/Blue Team)**: 7 findings from parallel Red Team + Blue Team review. All fixed.
- **2026-04-16 (Round 5 — Final verification)**: Red Team and Blue Team independently confirmed all fixes. 0 new vulnerabilities. **LGTM: Ready for publish.**
- **2026-04-17 (Round 6 — Feature 2 Red/Blue)**: PDF/MD ingest + MCP trigger (feature 2 + 2.1). Findings addressed pre-merge (VULN-020..028). See [`security-review/meeting/2026-04-17_feature-2-red-blue.md`](security-review/meeting/2026-04-17_feature-2-red-blue.md).
- **2026-04-20 (Round 7 — Feature 2.2 code-quality + Red/Blue)**: URL/HTML ingest (`kioku_ingest_url`). code-quality reviewer found CRIT-1 (late-PDF binary refetch) + HIGH-1/2/3 + MED-1/3/4/5. Red × Blue parallel review then confirmed HIGH=0 / MEDIUM=0 after the fixes. v0.3.0 shipped on this baseline.
- **2026-04-20 (v0.3.0 post-release — differential + boundary review)**: Cross-tool integration and new data-path review after v0.3.0. Five HIGH findings were remediated in the v0.3.1 hotfix (distributed `.gitignore` sync bug, attacker images in Git repo, `KIOKU_` child env leak, SECURITY.md drift, `kioku_delete` orphan-wikilink scope gap). See [`security-review/findings/2026-04-20_v0-3-0-post-release-review.md`](security-review/findings/2026-04-20_v0-3-0-post-release-review.md).

### Network Policy

Hook scripts (`session-logger.mjs`, `wiki-context-injector.mjs`) do **not** import `http`, `https`, `net`, or `dgram`. All network operations (git pull/push) are performed by shell one-liners in the Hook configuration, not by Node.js code.

**Phase M / kioku-wiki MCP server**: The MCP server (`mcp/server.mjs`) runs as a separate process and may import the bundled `@modelcontextprotocol/sdk`. It uses **stdio transport only** — there is no `http`/`https`/`net`/`dgram` import in either `server.mjs` or any `tools/*.mjs` / `lib/*.mjs`. The server reads JSON-RPC messages from stdin and writes them to stdout; the parent client (Claude Desktop / Claude Code) is the only counterpart. The "stdlib only" policy is therefore scoped to **Hook scripts**; the MCP server is treated as an independent process boundary that may carry an SDK dependency.

### Phase M Write Boundaries

The MCP server adds write paths that did not exist before. The matrix:

| Caller | Write target | Permissions | Boundary check |
|---|---|---|---|
| Hook (`session-logger.mjs`) | `session-logs/` | dir 0700 / file 0600 | (path-internal) |
| cron (`auto-ingest.sh`, `auto-lint.sh`) | `wiki/` | inherits Vault perms | (no MCP gate) |
| MCP `kioku_write_note` | `session-logs/` | dir 0700 / file 0600 | `assertInsideSessionLogs(rel)` |
| MCP `kioku_write_wiki` | `wiki/` | file 0600 (atomic via tmpfile + rename) | `assertInsideWiki(rel)` |
| MCP `kioku_delete` | `wiki/` → `wiki/.archive/` | dir 0700 (archive) | `assertInsideWiki(rel)` + `wiki/index.md` rejected |
| MCP `kioku_ingest_pdf` (feature 2.1) | `.cache/extracted/` + `wiki/summaries/` | dir 0700 / file 0600 | `assertInsideRawSources` + extension whitelist + `withLock` |
| MCP `kioku_ingest_url` (feature 2.2) | `raw-sources/<subdir>/fetched/` | dir 0700 / file 0600 | `assertInsideRawSourcesSubdir` + atomic tmp+rename |
| MCP `kioku_ingest_url` (images) | `raw-sources/<subdir>/fetched/media/<host>/` | file 0600 / sha256-named | MIME whitelist + hostname traversal guard + git-ignored |
| MCP `kioku_ingest_url` (raw HTML cache) | `.cache/html/` | dir 0700 / file 0600 | `urlToFilename` sanitizer (SAFE_PATH_RE compatible) + git-ignored |

Cross-boundary writes (e.g. `kioku_write_wiki` pointing into `session-logs/`) are rejected at the realpath stage. All wiki/ writes are serialized through `$VAULT/.kioku-mcp.lock` (advisory flock with 30 s TTL) so MCP and `auto-ingest.sh` cannot collide. `kioku_ingest_url` dispatches to `kioku_ingest_pdf` with `skipLock=true` to avoid re-entrance on the same lock. `MASK_RULES` (mirror of `session-logger.mjs`) is applied to every `body` argument **and** URL-derived frontmatter fields before persistence.

### Outbound Network Policy (feature 2.2)

Feature 2.2 introduces the first outbound HTTP/HTTPS calls from the codebase. They are restricted to explicit `kioku_ingest_url` tool invocations and the cron URL pre-step; Hook scripts and core MCP tools continue to have **no** network imports.

- Host ↔ IP pinning: DNS lookup is performed once up front, the resolved IP is validated against `isPrivateIP` / `isLoopbackIP` / `isLinkLocalIP` and metadata endpoints, and then `fetch` is invoked with a custom `lookup` that returns the pinned IP — so redirects cannot rebind to an internal address.
- Every redirect hop re-validates the next URL via `validateUrl` and re-runs the DNS pin, preventing late SSRF via 30x chains.
- Caps: `DEFAULT_MAX_BYTES` 5 MB (HTML) / 50 MB (PDF), `DEFAULT_TIMEOUT_MS` 30 s, `DEFAULT_MAX_REDIRECTS` 5. All read from env via `envPositiveInt` so `=""` or `=NaN` fall back to the safe default (fail-closed on misconfiguration).

### Child Process Env Allowlist (feature 2.1+2.2, HIGH-d1 fix 2026-04-20)

The MCP server spawns child processes for two tools:
- `kioku_ingest_pdf` → `extract-pdf.sh` (chunking) + `claude -p` (summarization)
- `kioku_ingest_url` (fallback path) → `claude -p` with `--allowedTools Write` chroot

To prevent secrets and security flags from leaking into the child context, `mcp/lib/child-env.mjs` applies a **strict allowlist**:

- Exact-match only: `PATH / HOME / USER / LOGNAME / SHELL / TERM / TZ / LANG / LC_ALL / LC_CTYPE / TMPDIR / NODE_PATH / NODE_OPTIONS / OBSIDIAN_VAULT / KIOKU_NO_LOG / KIOKU_MCP_CHILD / KIOKU_DEBUG / KIOKU_LLM_FB_OUT / KIOKU_LLM_FB_LOG`
- Prefix match only for: `ANTHROPIC_*` (claude CLI auth), `CLAUDE_*` (claude CLI settings), `XDG_*` (config dir resolution)
- **Excluded**: all `KIOKU_URL_*` / `KIOKU_EXTRACT_*` / `KIOKU_ALLOW_EXTRACT_*` / `KIOKU_INGEST_MAX_SECONDS`. These are test or operator flags that would silently lift SSRF / robots / bash-override guards if propagated.

This defense-in-depth addresses the risk of a test fixture leaking into production (for example, a developer leaving `KIOKU_URL_ALLOW_LOOPBACK=1` in `~/.zprofile`). Even if the parent leaks, the child is clean.

`scripts/install-mcp-client.sh` writes to `~/Library/Application Support/Claude/claude_desktop_config.json` only with `--apply`. It uses `jq` for idempotent merges, validates `OBSIDIAN_VAULT` against `^[a-zA-Z0-9/._[:space:]-]+$`, refuses to touch broken JSON, and creates `.bak.YYYYMMDD-HHMMSS` backups.
