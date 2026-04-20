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
| **攻撃 URL 経由の SSRF** (機能 2.2, `kioku_ingest_url`) | `mcp/lib/url-security.mjs` + `url-fetch.mjs` の 2 段ガード: 事前解決で localhost / RFC1918 / link-local / AWS/GCP metadata / IPv4-mapped IPv6 / 10 進・16 進・8 進 IP 表記 / URL credentials を reject、resolved IP を DNS lookup に pin して redirect / DNS rebinding も遮断 |
| **redirect 時の scheme downgrade** (機能 2.2) | HTTPS → HTTP 降格 redirect を明示的に検知して reject (`url-fetch.mjs`) |
| **robots.txt bypass** (機能 2.2) | `mcp/lib/robots-check.mjs` を MCP tool 入口 + `extractAndSaveUrl` で二重 enforce。明示 opt-out は `KIOKU_URL_IGNORE_ROBOTS=1` + 起動時 stderr WARN |
| **fetched HTML からの prompt injection** (機能 2.2) | Mozilla Readability は visible body だけ抽出 (script / style / noscript を strip)。LLM fallback は `claude -p --allowedTools Write(<absCacheDir>/llm-fb-*.md)` + chdir + 最小 child env (下記 "子プロセス env allowlist" 参照) |
| **`.cache/html/` に攻撃 HTML が残る** (機能 2.2) | `.cache/` + `.cache/html/` を `templates/vault/.gitignore` で除外、dir `0o700` / file `0o600`、ファイル名は `urlToFilename` sanitizer (SAFE_PATH_RE 互換) 経由後に realpath join |
| **攻撃 HTML の画像が Vault を膨張させる** (機能 2.2) | `raw-sources/**/fetched/media/` を git-ignore (ローカルは Obsidian 表示のため残すが Git には入れない)。MIME whitelist (jpeg/png/webp/gif)、SVG / 1×1 tracking pixel は skip、1 画像 20 MB cap |
| **child env に SSRF/robots bypass フラグが漏れる** (機能 2.2, HIGH-d1 fix) | `mcp/lib/child-env.mjs` で exact-match allowlist。`KIOKU_URL_*` / `KIOKU_EXTRACT_*` / `KIOKU_ALLOW_EXTRACT_*` は **propagate しない**。内部フラグ (`KIOKU_NO_LOG` / `KIOKU_MCP_CHILD` / `KIOKU_DEBUG` / `KIOKU_LLM_FB_*`) のみ child MCP / `claude -p` に通す |
| **HTML meta タグ経由の frontmatter 秘匿情報漏れ** (機能 2.2) | `applyMasks` を body + `title` / `tags` / `byline` / `site_name` / `source_type` / `og_image` / `published_time` / `source_final_url` / `source_host` / `warnings` の全てに適用 (`url-extract.mjs#buildFrontmatterObject`) |
| **MCP エラーメッセージに内部 IP / URL が漏れる** (機能 2.2) | `mapFetchErrorAndThrow` (`ingest-url.mjs` / `url-extract-cli.mjs`) は security 系 code (`dns_private` / `url_scheme` 等) でエラーコードのみ返す。attacker-controlled な文字列が Claude context や cron log に流れない |

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
- **2026-04-17 (Round 6 — 機能 2 Red/Blue)**: PDF/MD ingest + MCP trigger (機能 2 + 2.1)。発見事項は全て merge 前に対応済 (VULN-020..028)。議事録: [`security-review/meeting/2026-04-17_feature-2-red-blue.md`](security-review/meeting/2026-04-17_feature-2-red-blue.md)。
- **2026-04-20 (Round 7 — 機能 2.2 code-quality + Red/Blue)**: URL/HTML ingest (`kioku_ingest_url`)。code-quality reviewer が CRIT-1 (late-PDF binary refetch) + HIGH-1/2/3 + MED-1/3/4/5 を発見。Red × Blue 並列 review で修正後 HIGH=0 / MEDIUM=0 を確認、v0.3.0 はこの基盤でリリース。
- **2026-04-20 (v0.3.0 post-release — 差分 + 境界レビュー)**: v0.3.0 merge 後の cross-tool 統合と新規データパス review。HIGH 5 件 (配布 .gitignore 同期バグ / 攻撃画像の Git 流入 / `KIOKU_` child env leak / SECURITY.md drift / `kioku_delete` orphan wikilink scope gap) を v0.3.1 hotfix で修正。詳細: [`security-review/findings/2026-04-20_v0-3-0-post-release-review.md`](security-review/findings/2026-04-20_v0-3-0-post-release-review.md)。

### Network Policy

Hook scripts (`session-logger.mjs`, `wiki-context-injector.mjs`) do **not** import `http`, `https`, `net`, or `dgram`. All network operations (git pull/push) are performed by shell one-liners in the Hook configuration, not by Node.js code.
