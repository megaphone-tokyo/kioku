## 本手册提供多种语言版本

> [!NOTE]
> **🌐 其他语言：** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · 🇨🇳 **简体中文** · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code 会随着会话结束而遗忘过去的知识。
kioku **自动将您的对话累积成 Wiki**，并在**下一次会话中回忆它们**。

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
> 本软件按**"现状"**提供，不附带任何形式的保证。作者对因使用本工具而产生的任何数据丢失、安全事件或损害**概不负责**。使用风险自负。完整条款请参阅 [LICENSE](LICENSE)。

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

1. 在 Obsidian 中创建新 Vault（例如 `~/kioku/main-kioku`）
2. 在 GitHub 上创建 Private 仓库（例如 `kioku`）
3. 在 Vault 目录中执行: `git init && git remote add origin ...`（或 `gh repo create --private --source=. --push`）

此步骤不由 kioku 脚本自动完成。GitHub 认证（gh CLI / SSH 密钥）取决于您的环境。

#### 2. 设置环境变量

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
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
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Open ~/kioku/main-kioku/ as a Vault in Obsidian
# Repeat steps 2–6
```

<br>

## 目录结构

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

## 环境变量

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | 无（必需） | Vault 根目录。auto-ingest/lint 回退到 `${HOME}/kioku/main-kioku` |
| `KIOKU_DRY_RUN` | `0` | 设为 `1` 跳过 `claude -p` 调用（仅路径验证） |
| `KIOKU_NO_LOG` | 未设置 | 设为 `1` 禁用 session-logger.mjs（防止 cron 子进程的递归日志记录） |
| `KIOKU_DEBUG` | 未设置 | 设为 `1` 向 stderr 和 `session-logs/.kioku/errors.log` 输出调试信息 |
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

kioku 的设计目标是通过 Git 同步**在多台机器之间共享单一 Wiki**。
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

kioku 是一个可以访问**所有 Claude Code 会话输入输出**的 Hook 系统。
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
- [ ] **Git 同步错误可见性** — 将 `git push` 失败记录至 `session-logs/.kioku/git-sync.log` 并在 auto-ingest 中显示警告

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

## 许可证

本项目采用 MIT 许可证。详情请参阅 [LICENSE](LICENSE)。

如上方"注意事项"所述，本软件按"现状"提供，不附带任何形式的保证。

<br>

## 参考

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 本项目实现的原始概念
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — 官方 Hook 系统文档
- [Obsidian](https://obsidian.md/) — 作为 Wiki 查看器使用的知识管理应用
- [qmd](https://github.com/tobi/qmd) — Markdown 本地搜索引擎（BM25 + 向量搜索）

<br>


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## 作者

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

用代码和 AI 构建各种东西。自由工程师，入行十年。以前端为主，最近的主要工作流程是与 Claude 协同开发。

[欢迎关注](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
