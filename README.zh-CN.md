## 本手册提供多种语言版本

> [!NOTE]
> **🌐 其他语言：** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · 🇨🇳 **简体中文** · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code 会随着会话结束而遗忘过去的知识。
KIOKU **自动将您的对话累积成 Wiki**，并在**下一次会话中回忆它们**。

不再需要反复重复相同的说明。一个随着每次使用而成长的"第二大脑"——为您的 Claude 而生。

<br>

## 功能概述

自动记录 Claude Code 会话，并在 Obsidian Vault 上构建结构化知识库。结合 Andrej Karpathy 的 LLM Wiki 模式与自动日志记录及跨多台机器的 Git 同步。

```
🗣️  像往常一样与 Claude Code 对话
         ↓  （一切自动记录 — 你不需要做任何事）
📝  会话日志保存在本地
         ↓  （定时任务让 AI 读取日志并提取知识）
📚  Wiki 随每次会话成长 — 概念、设计决策、模式
         ↓  （通过 Git 同步）
☁️  GitHub 备份你的 Wiki 并在多台机器间共享
```

1. **自动捕获 (L0)**: 捕获 Claude Code Hook 事件（`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`），将 Markdown 写入 `session-logs/`
2. **结构化 (L1)**: 定时执行（macOS LaunchAgent / Linux cron）让 LLM 读取未处理的日志，在 `wiki/` 中构建概念页面、项目页面和设计决策。会话分析结果也保存在 `wiki/analyses/`
3. **完整性检查 (L2)**: 每月 Wiki 健康检查，生成 `wiki/lint-report.md`。内置自动密钥泄露检测
4. **同步 (L3)**: Vault 本身是一个 Git 仓库。`SessionStart` 执行 `git pull`，`SessionEnd` 执行 `git commit && git push`，通过 GitHub Private 仓库在多台机器间同步
5. **Wiki 上下文注入**: 在 `SessionStart` 时，将 `wiki/index.md` 注入系统提示，使 Claude 能够利用过往知识
6. **qmd 全文搜索**: 通过 MCP 使用 BM25 + 语义搜索来搜索 Wiki
7. **Wiki Ingest 技能**: `/wiki-ingest-all` 和 `/wiki-ingest` 斜杠命令可将已有项目知识导入 Wiki
8. **密钥隔离**: `session-logs/` 按机器保留在本地（`.gitignore`）。仅 `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` 纳入 Git 管理

<br>

## 注意事项

> [!CAUTION]
> KIOKU 目前需要 **Claude Code（Max 方案）**。Hook 系统（L0）和 Wiki 上下文注入是 Claude Code 专属功能。Ingest/Lint 管线（L1/L2）可通过替换 `claude -p` 调用来搭配其他 LLM API 使用——这已列入未来增强计划。

> [!IMPORTANT]
> 本软件按**"现状"**提供，不附带任何形式的保证。作者对因使用本工具而产生的任何数据丢失、安全事件或损害**概不负责**。使用风险自负。完整条款请参阅 [LICENSE](../../LICENSE)。

<br>

## 前提条件

| | Version / Requirement |
|---|---|
| macOS | 推荐 13+ |
| Node.js | 18+（Hook 脚本为 `.mjs` ES Modules，零外部依赖） |
| Bash | 3.2+（macOS 默认版本） |
| Git | 2.x+。须支持 `git pull --rebase` / `git push` |
| GitHub CLI | 可选（`gh` 可简化私有仓库创建） |
| Claude Code | 需要 **Max 方案**（使用 `claude` CLI 和 `~/.claude/settings.json` 中的 Hook 系统） |
| Obsidian | 在任意文件夹中创建一个 Vault（无需 iCloud Drive） |
| jq | 1.6+（`install-hooks.sh --apply` 使用） |
| 环境变量 | `OBSIDIAN_VAULT` 指向 Vault 根目录 |

<br>

## 快速开始

> [!WARNING]
> **安装前请先了解：** KIOKU 会 hook 进**所有 Claude Code 会话的 I/O**。这意味着：
> - 会话日志可能包含来自您的提示和工具输出中的 **API 密钥、令牌或个人信息**。脱敏涵盖主要模式，但并非详尽——请参阅 [SECURITY.md](SECURITY.md)
> - 如果 `.gitignore` 配置错误，会话日志可能会**意外推送到 GitHub**
> - 自动 Ingest 管线会通过 `claude -p` 将会话日志内容发送给 Claude 进行 Wiki 提取
>
> 建议先使用 `KIOKU_DRY_RUN=1` 验证管线运作，然后再启用完整操作。

### 🚀 交互式设置（推荐）

> [!NOTE]
> 在 Claude Code 中输入以下指令，开始交互式引导设置。它会解释每个步骤的目的，并根据您的环境进行调整。

```
Please read skills/setup-guide/SKILL.md and guide me through the KIOKU installation.
```

### 🛠️ 手动设置

> [!NOTE]
> 适合想要了解每个步骤的用户。直接运行脚本。

#### 1. 创建 Vault 并连接 Git 仓库（手动）

1. 在 Obsidian 中创建新 Vault（例如 `~/kioku-vault/main`）
2. 在 GitHub 上创建 Private 仓库（例如 `kioku-vault`）
3. 在 Vault 目录中执行: `git init && git remote add origin ...`（或 `gh repo create --private --source=. --push`）

此步骤不由 KIOKU 脚本自动完成。GitHub 认证（gh CLI / SSH 密钥）取决于您的环境。

#### 2. 设置环境变量

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku-vault/main"
```

#### 3. 初始化 Vault

```bash
# Creates raw-sources/, session-logs/, wiki/, templates/ under the Vault,
# places CLAUDE.md / .gitignore / initial templates (never overwrites existing files)
bash scripts/setup-vault.sh
```

#### 4. 安装 Hook

```bash
# Option A: Auto-merge (recommended, requires jq)
bash scripts/install-hooks.sh --apply
# Creates backup → shows diff → confirmation prompt → adds hook entries preserving existing config

# Option B: Manual merge
bash scripts/install-hooks.sh
# Outputs JSON snippet to stdout for manual merge into ~/.claude/settings.json
```

#### 5. 验证

重启 Claude Code，然后进行一次对话。
应该会出现 `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` 文件。

> **步骤 1–5 为必要步骤。** 以下为可选，但建议启用以获得完整功能。

#### 6. 设置定时执行（推荐）

配置自动 Ingest（每日）和 Lint（每月）。

```bash
# Auto-detects OS: macOS → LaunchAgent, Linux → cron
bash scripts/install-schedule.sh

# Test with DRY RUN first
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **macOS 注意**: 将仓库放在 `~/Documents/` 或 `~/Desktop/` 下可能导致 TCC（透明度、同意和控制）阻止后台访问并报 EPERM 错误。请使用受保护目录之外的路径（例如 `~/_PROJECT/`）。

#### 7. 设置 qmd 搜索引擎（可选）

启用基于 MCP 的全文和语义搜索。

```bash
bash scripts/setup-qmd.sh
bash scripts/install-qmd-daemon.sh
```

#### 8. 安装 Wiki Ingest 技能（可选）

```bash
bash scripts/install-skills.sh
```

#### 9. 部署到其他机器

```bash
git clone git@github.com:<USERNAME>/kioku-vault.git ~/kioku-vault/main
# Open ~/kioku-vault/main/ as a Vault in Obsidian
# Repeat steps 2–6
```

<br>

## 目录结构

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

## 环境变量

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | 无（必需） | Vault 根目录。auto-ingest/lint 回退到 `${HOME}/kioku-vault/main` |
| `KIOKU_DRY_RUN` | `0` | 设为 `1` 跳过 `claude -p` 调用（仅路径验证） |
| `KIOKU_NO_LOG` | 未设置 | 设为 `1` 禁用 session-logger.mjs（防止 cron 子进程的递归日志记录） |
| `KIOKU_DEBUG` | 未设置 | 设为 `1` 向 stderr 和 `session-logs/.claude-brain/errors.log` 输出调试信息 |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ingest 日志输出路径（auto-lint 自诊断引用） |

### Node 版本管理器 PATH 设置

定时脚本（`auto-ingest.sh`、`auto-lint.sh`）从 cron / LaunchAgent 运行，不会继承交互式 Shell 的 PATH。它们会将 Volta（`~/.volta/bin`）和 mise（`~/.local/share/mise/shims`）添加到 PATH。**如果您使用 nvm / fnm / asdf 或其他版本管理器**，请编辑各脚本顶部的 `export PATH=...` 行:

```bash
# nvm example
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# fnm example
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## 设计说明

- **会话日志包含密钥**: 提示和工具输出可能包含 API 密钥、令牌或个人身份信息。`session-logger.mjs` 在写入前进行正则表达式脱敏
- **写入边界**: Hook 仅写入 `$OBSIDIAN_VAULT/session-logs/`。不会触及 `raw-sources/`、`wiki/` 或 `templates/`
- **session-logs 不会进入 Git**: 被 `.gitignore` 排除，最大限度降低意外推送到 GitHub 的风险
- **无网络访问**: Hook 脚本（`session-logger.mjs`）不导入 `http`/`https`/`net`/`dgram`。Git 同步由 Hook 配置中的 Shell 单行命令处理
- **幂等性**: `setup-vault.sh` / `install-hooks.sh` 可多次运行而不会破坏已有文件
- **不执行 git init**: `setup-vault.sh` 不会初始化 Git 仓库或添加远程地址。GitHub 认证由用户自行负责

<br>

## 多机器设置

KIOKU 的设计目标是通过 Git 同步**在多台机器之间共享单一 Wiki**。
作者使用双 Mac 配置：MacBook（主要开发机）和 Mac mini（用于 Claude Code bypass permission 模式）。

多机器操作的要点：
- **`session-logs/` 保留在各机器本地**（被 `.gitignore` 排除）。每台机器的会话日志独立且不会推送至 Git
- **`wiki/` 通过 Git 同步**。任何机器的 Ingest 结果都会累积在同一个 Wiki 中
- **错开各机器的 Ingest/Lint 执行时间**以避免 git push 冲突
- SessionEnd Hook 的自动 commit/push 在所有机器上启用，但一般的代码会话只会写入 `session-logs/`——git 操作只在 `wiki/` 被直接修改时触发

参考：作者的双 Mac 配置

| | MacBook（主要） | Mac mini（bypass） |
|---|---|---|
| 密钥信息 | 有 | 无 |
| `session-logs/` | 仅本地 | 仅本地 |
| `wiki/` | Git 同步 | Git 同步 |
| Ingest 排程 | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint 排程 | 每月 1 日 8:00 | 每月 2 日 8:00 |
| 调度器 | LaunchAgent | LaunchAgent |

> 如果您只使用一台机器，可以完全忽略本节。快速开始的步骤就是您所需要的全部。

<br>

## 安全性

KIOKU 是一个可以访问**所有 Claude Code 会话输入输出**的 Hook 系统。
完整的安全设计请参见 [SECURITY.md](SECURITY.md)。

### 防御层

| Layer | Description |
|---|---|
| **输入验证** | 检查 `OBSIDIAN_VAULT` 路径中的 Shell 元字符和 JSON/XML 控制字符 |
| **脱敏处理** | API 密钥（Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure）、Bearer/Basic 认证、URL 凭据、PEM 私钥均替换为 `***` |
| **权限控制** | `session-logs/` 以 `0o700` 创建，日志文件以 `0o600` 创建。Hook 脚本设置为 `chmod 755` |
| **.gitignore 守护** | 每次 git commit 前验证 `.gitignore` 包含 `session-logs/` |
| **递归防护** | `KIOKU_NO_LOG=1` + cwd-in-vault 检查（双重守护）防止子进程递归日志记录 |
| **LLM 权限限制** | auto-ingest / auto-lint 以 `--allowedTools Write,Read,Edit`（无 Bash）运行 `claude -p` |
| **定期扫描** | `scan-secrets.sh` 每月扫描 session-logs/ 中的已知令牌模式，检测脱敏遗漏 |

### 添加令牌模式

当您开始使用新的云服务时，请将其令牌模式同时添加到 `hooks/session-logger.mjs`（`MASK_RULES`）和 `scripts/scan-secrets.sh`（`PATTERNS`）。

### 报告漏洞

如果您发现安全问题，请通过 [SECURITY.md](SECURITY.md) 报告，而非通过公开 Issue。

<br>

## 路线图

### 近期
- [ ] **Ingest 质量调优** — 在 2 周的实际 Ingest 运行后，检视并调整 Vault CLAUDE.md 中的选取标准
- [ ] **qmd 多语言搜索** — 验证非英文内容的语义搜索准确度；如需要则更换嵌入模型（例如 `multilingual-e5-small`）
- [ ] **安全自动修复技能 (`/wiki-fix-safe`)** — 在人工批准下自动修复琐碎的 Lint 问题（添加缺失的交叉链接、填补 frontmatter 缺漏）
- [ ] **Git 同步错误可见性** — 将 `git push` 失败记录至 `session-logs/.claude-brain/git-sync.log` 并在 auto-ingest 中显示警告

### 中期
- [ ] **多 LLM 支持** — 将 auto-ingest/lint 中的 `claude -p` 替换为可插拔的 LLM 后端（OpenAI API、通过 Ollama 的本地模型等）
- [ ] **CI/CD** — 推送时通过 GitHub Actions 进行自动化测试
- [ ] **Lint diff 通知** — 与上次 lint 报告比较，仅显示*新检测到的*问题
- [ ] **index.json 的乐观锁定** — 防止多个 Claude Code 会话并行时的更新丢失

### 长期
- [ ] **晨间简报** — 自动生成每日摘要（昨日的会话、待决事项、新洞见）为 `wiki/daily/YYYY-MM-DD.md`
- [ ] **项目感知的上下文注入** — 根据当前项目（基于 `cwd`）过滤 `wiki/index.md` 以保持在 10,000 字符限制内
- [ ] **技术栈推荐技能 (`/wiki-suggest-stack`)** — 根据累积的 Wiki 知识为新项目建议技术栈
- [ ] **团队 Wiki** — 多人 Wiki 共享（每位成员的 session-logs 保留在本地；仅 wiki/ 通过 Git 共享）

> **注意**：KIOKU 目前需要 **Claude Code（Max 方案）**。Hook 系统（L0）和 Wiki 上下文注入是 Claude Code 专属功能。Ingest/Lint 管线（L1/L2）可通过替换 `claude -p` 调用来搭配其他 LLM API 使用——这已列入未来增强计划。

<br>

## 更新历史

### 2026-04-24 — v0.6.0：生态系统扩展 — 多代理 + 插件 marketplace + Bases 仪表板 + delta tracking + 安全加固

v0.6.0 整合 Phase C。

- **多代理 cross-platform (C-1)** — `scripts/setup-multi-agent.sh` 将 KIOKU skills 符号链接到 Codex / OpenCode / Gemini CLI。19/19 Bash 断言
- **Claude Code plugin marketplace (C-2)** — `claude marketplace add megaphone-tokyo/kioku && claude plugin install kioku@megaphone-tokyo`
- **Raw MD sha256 delta tracking (C-3)** — `raw-sources/<subdir>/*.md` 的 MD 参与 sha256 delta 检测。82/82 auto-ingest 断言
- **Obsidian Bases 仪表板 (C-4)** — `templates/wiki/meta/dashboard.base` 9 种视图
- **Visualizer 基础 (V-1，v0.7 α 准备)** — `mcp/lib/git-history.mjs` + `mcp/lib/wiki-snapshot.mjs`，14/14 Node 断言
- **安全策略升级 (C-5a)** — `SECURITY.md` 新增 CVE Classification / Safe Harbor / Coordinated Disclosure Timeline。`SECURITY.ja.md` 4/7 小节
- **社区渠道转向** — 专用 Discord 不采用，GitHub Discussions 官方渠道
- **组织知识** — LEARN#10（PM handoff 创建时 script line verify 必须化）
- **推迟到 v0.7+** — Visualizer HTML UI、LP β、GitHub Discussions 启用、SECURITY.ja 剩余 3 小节
- 测试：**Node 264/264 + Bash 400+/400+ 断言全绿**
- [Release v0.6.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.6.0) — `kioku-wiki-0.6.0.mcpb` (~9 MB)

### 2026-04-23 — v0.5.1：热缓存 + PostCompact hook + opt-in Stop prompt

- **热缓存模式** — 新增 `wiki/hot.md`（≤500 词，硬上限 4000 字符），在 **SessionStart** 时自动注入，并在 **PostCompact**（上下文压缩）后重新注入，让 LLM 在会话和压缩之间保留短期工作上下文。灵感来自 claude-obsidian 的 UX 模式
- **PostCompact hook** — `install-hooks.sh` 现在接入第 6 个事件（`PostCompact`），仅重新注入 hot.md（压缩后 index.md 已在上下文中，因此跳过以避免 token 膨胀）
- **Opt-in Stop prompt**（`KIOKU_HOT_AUTO_PROMPT=1`）— 显式设置时，会话结束会触发 hot.md 更新建议 prompt。**默认 OFF** — hot.md 通过 Git 同步，比 session-logs 有更严格的安全边界，因此自动 prompt 需要用户的明确同意
- **安全边界维持** — hot.md 在注入前通过 `applyMasks()`（API key / token 模式屏蔽），包含在 scan-secrets.sh walk 目标中，通过 `realpath` 拒绝 symlink escape（vault 外路径被拒绝），并在 4000 字符处截断 + 输出 WARN log
- **Claude Code v2 hook schema 对齐（4 个 hotfix）** — Claude Code v2 对不同事件使用不同的输出 schema：`hookSpecificOutput` 仅支持 `PreToolUse` / `UserPromptSubmit` / `PostToolUse`；`PostCompact` 和 `Stop` 必须使用顶层 `systemMessage`。旧的 v1 扁平 `{additionalContext}` 在 v2 中被静默丢弃。Hotfix 1-4 将所有 hook 输出按事件迁移到正确的 schema
- 测试：**Node 47 断言**（HOT-1..9d + HOT-V1/V2 + session-logger 回归 + injector H1-H5）**+ Bash 488 断言**（IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 现有 15 suites），全绿
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` 附件（9.2 MB）

### 2026-04-23 — v0.5.0：功能 2.4 — PDF / MD / EPUB / DOCX 统一 ingest 路由

- **Phase 1** — `kioku_ingest_document` 路由器：一个统一的 MCP 工具，根据文件扩展名（`.pdf` / `.md` / `.epub` / `.docx`）分发到对应的 handler。原有的 `kioku_ingest_pdf` 转为 deprecation alias，在 v0.5 – v0.7 窗口内保留，计划在 v0.8 移除
- **Phase 2** — EPUB ingest：基于 yauzl 的安全解压，配备 8 层防御（zip-slip / symlink / 累积大小上限 / entry 数量上限 / NFKC 文件名 / 嵌套 ZIP skip / XXE pre-scan / XHTML script sanitize）。按 spine 顺序的章节通过 `readability-extract` + `turndown` 转换为 Markdown chunks，保存到 `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`；多章 EPUB 还会生成一份 `-index.md`。LLM summary 通过 auto-ingest cron 异步流转
- **Phase 3** — DOCX ingest（MVP）：`mammoth + yauzl` 两层架构（mammoth 内部 jszip 的 attack surface 由 yauzl 的 8 层防御前置守护）。`word/document.xml` / `docProps/core.xml` 经过 XXE pre-scan（`assertNoDoctype`）。图像（VULN-D004/D007）和 OLE 嵌入内容（VULN-D006）延后处理——MVP 仅抽取正文 + 标题。Metadata 以 `--- DOCX METADATA ---` fence 包裹并标注 **untrusted**，用于划定 prompt injection 与下游 LLM summarization 的界限
- **Pre-release hotfix** — 修复 `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` 中的 argv 正则，使其支持 Unicode（`\p{L}\p{N}`）；之前的 `\w`（仅 ASCII）会在 auto-ingest cron 路径中静默跳过 `論文.docx` / `日本語.epub` 等中日文文件名。EPUB 自 v0.4.0 起便存在此隐性 regression，此次追溯修复（LEARN#6 cross-boundary drift）。此外将 `meta` / `base` / `link` 加入 `html-sanitize` 的 `DANGEROUS_TAGS`，作为未来 EPUB 消费路径的纵深防御
- **Known issue（不适用）** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6)，medium) 针对的是 **XMLBuilder** API（XML writer）。本代码库在 `mcp/lib/xml-safe.mjs` 中仅使用 **XMLParser**（XML reader），因此该漏洞无法被利用。依赖将在 **v0.5.1** 升级到 `fast-xml-parser@^5.7.0` 以清除 dependabot alert
- 测试：**158 个 Bash assertions + 完整 Node suite 全绿**（extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30）。`npm audit` 在运行时依赖上报告 **0 个漏洞**；red-hacker + blue-hacker 并行 `/security-review` 报告 **0 个 HIGH/CRITICAL** findings
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — 已附带 `kioku-wiki-0.5.0.mcpb`（9.2 MB）

### 2026-04-21 — v0.4.0：Tier A（安全 + 运维）+ Tier B（代码整洁度）整体改进

- **A#1** — 将 `@mozilla/readability` 从 0.5 升级至 0.6（缓解 ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7)；144 个生产依赖通过 `npm audit` clean）
- **A#2** — 为 `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` 的 SessionEnd 添加 `git symbolic-ref -q HEAD` guard，防止在 Vault 处于 detached-HEAD 状态时出现失控 commit（修复前曾在一台机器上观察到 5 天的 drift）
- **A#3** — 重构 `withLock`（将持锁时间从数分钟缩短至数秒），完全移除 `skipLock` API，并新增 orphan-PDF cleanup
- **B#1** — Hook 层 re-audit（`session-logger.mjs`）：修复 3 个 MEDIUM findings（invisible-character 绕过 masking、frontmatter 中的 YAML injection、`KIOKU_NO_LOG` strict-equality drift）
- **B#2** — 将 cron/setup guard parity 正式化为 `tests/cron-guard-parity.test.sh`（17 个 assertions），强制执行 Category-A / Category-B env-override 规范
- **B#3** — 通过 `check_github_side_lock`（α guard，默认 120s 窗口，可通过 `KIOKU_SYNC_LOCK_MAX_AGE` 配置）防止 `sync-to-app.sh` 的跨机器 race；由 `tests/sync-to-app.test.sh`（11 个 assertions）锁定 regression
- **B#8** — README i18n parity：为全部 8 个非 en/ja 的 README 添加 §10 MCP / §11 MCPB / Changelog 章节（+1384 行）
- 测试：**299 个 Node tests** + **15 个 Bash suites / 415 个 assertions**，全部通过
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — 附带 `.mcpb`

### 2026-04-17 — Phase N：面向 Claude Desktop 的 MCPB 包
- 新增 `mcp/manifest.json`（MCPB v0.4）和 `scripts/build-mcpb.sh`，可生成 `mcp/dist/kioku-wiki-<version>.mcpb`（约 3.2 MB）
- Claude Desktop 用户只需拖放一个 `.mcpb` 文件即可完成 MCP 服务器安装。`OBSIDIAN_VAULT` 通过安装对话框中的目录选择器配置（用户机器无需安装 Node — 由 Desktop 内置的运行时启动）
- 详细说明请参考 [README.md](README.md) 或 [README.ja.md](README.ja.md)

### 2026-04-17 — Phase M：kioku-wiki MCP 服务器
- 本地 stdio MCP 服务器（`mcp/`）提供六个工具 — `kioku_search`、`kioku_read`、`kioku_list`、`kioku_write_note`、`kioku_write_wiki`、`kioku_delete`
- Claude Desktop 与 Claude Code 现在均可在不离开聊天界面的情况下浏览、搜索和编辑 Wiki
- 配置说明请参考 [README.md](README.md) 或 [README.ja.md](README.ja.md)

### 2026-04-16 — Phase L：迁移到 macOS LaunchAgent
- 新调度脚本 `scripts/install-schedule.sh` 自动判别 macOS LaunchAgent / Linux cron

<br>

## 许可证

本项目采用 MIT 许可证。详情请参阅 [LICENSE](../../LICENSE)。

如上方"注意事项"所述，本软件按"现状"提供，不附带任何形式的保证。

<br>

## 参考

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 本项目实现的原始概念
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — 官方 Hook 系统文档
- [Obsidian](https://obsidian.md/) — 作为 Wiki 查看器使用的知识管理应用
- [qmd](https://github.com/tobi/qmd) — Markdown 本地搜索引擎（BM25 + 向量搜索）

<br>

## 作者

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

用代码和 AI 构建各种东西。自由工程师，入行十年。以前端为主，最近的主要工作流程是与 Claude 协同开发。

[欢迎关注](https://x.com/megaphone_tokyo)
