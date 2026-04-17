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
| API keys/tokens leaking into session logs | Regex masking (`MASK_RULES` in `session-logger.mjs`) covers Anthropic, OpenAI, GitHub, AWS, Slack, Vercel, npm, Stripe, Bearer/Basic auth, URL credentials, PEM keys |
| Session logs pushed to GitHub | `.gitignore` excludes `session-logs/`. SessionEnd git hook verifies `.gitignore` integrity before committing |
| Hook script tampering | `install-hooks.sh --apply` sets `chmod 755` on hook scripts. Only owner can write |
| Shell/XML/JSON injection via OBSIDIAN_VAULT | `validate_vault_path()` rejects shell metacharacters, JSON control characters, and XML special characters |
| Prompt injection via session logs in auto-ingest | `claude -p` runs with `--allowedTools Write,Read,Edit` only (no Bash). LLM cannot execute shell commands |
| Recursive logging (subprocess logs itself) | `KIOKU_NO_LOG=1` env var + cwd-in-vault check (double guard) |
| qmd MCP exposing data on LAN | Binds to `127.0.0.1` only. Logs written to `~/.local/log/` (not `/tmp/`) |
| Insecure file permissions on shared systems | `session-logs/` created with `0o700`, files with `0o600`. `setup-vault.sh` sets `umask 077` |
| session-logs searchable via qmd | `brain-logs` collection is opt-in only (`setup-qmd.sh --include-logs`) |
| Non-portable binary checks | PATH binary ownership check uses POSIX `ls -ln | awk` (works on macOS and Linux) |

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

### Network Policy

Hook scripts (`session-logger.mjs`, `wiki-context-injector.mjs`) do **not** import `http`, `https`, `net`, or `dgram`. All network operations (git pull/push) are performed by shell one-liners in the Hook configuration, not by Node.js code.
