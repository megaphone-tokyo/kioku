## 本手冊提供多種語言版本

> [!NOTE]
> **🌐 其他語言：** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · 🇹🇼 **繁體中文** · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code 會隨著工作階段結束而忘記過去的知識。
claude-brain **自動將您的對話累積成 Wiki**，並在**下一次工作階段中回憶它們**。

不再需要反覆重複相同的說明。一個隨著每次使用而成長的「第二大腦」——為您的 Claude 而生。

<br>

## 功能概述

自動記錄 Claude Code 工作階段，並在 Obsidian Vault 上建構結構化知識庫。結合 Andrej Karpathy 的 LLM Wiki 模式與自動日誌記錄及跨多台機器的 Git 同步。

```
🗣️  像平常一樣與 Claude Code 對話
         ↓  （一切自動記錄 — 您無需做任何事）
📝  工作階段日誌儲存在本地
         ↓  （排程任務讓 AI 閱讀日誌並提取知識）
📚  Wiki 隨每次工作階段成長 — 概念、決策、模式
         ↓  （透過 Git 同步）
☁️  GitHub 備份您的 Wiki 並在多台機器間共享
```

1. **自動擷取 (L0)**：擷取 Claude Code hook 事件（`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`）並將 Markdown 寫入 `session-logs/`
2. **結構化 (L1)**：排程執行（macOS LaunchAgent / Linux cron）讓 LLM 讀取未處理的日誌，在 `wiki/` 中建構概念頁面、專案頁面和設計決策。工作階段分析結果也會儲存至 `wiki/analyses/`
3. **完整性檢查 (L2)**：每月 wiki 健康檢查產生 `wiki/lint-report.md`。包含自動機密洩漏偵測
4. **同步 (L3)**：Vault 本身就是一個 Git 儲存庫。`SessionStart` 執行 `git pull`，`SessionEnd` 執行 `git commit && git push`，透過 GitHub Private 儲存庫在多台機器間同步
5. **Wiki 上下文注入**：在 `SessionStart` 時，將 `wiki/index.md` 注入系統提示詞，讓 Claude 能運用過去的知識
6. **qmd 全文搜尋**：透過 MCP 以 BM25 + 語義搜尋查詢 wiki
7. **Wiki Ingest 技能**：`/wiki-ingest-all` 和 `/wiki-ingest` 斜線指令可將現有專案知識匯入 Wiki
8. **機密隔離**：`session-logs/` 保留在各機器本地（`.gitignore`）。只有 `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` 受 Git 管理

<br>

## 注意事項

> [!CAUTION]
> claude-brain 目前需要 **Claude Code（Max 方案）**。Hook 系統（L0）和 Wiki 上下文注入是 Claude Code 專屬功能。Ingest/Lint 管線（L1/L2）可透過替換 `claude -p` 呼叫來搭配其他 LLM API 使用——這已列入未來增強計畫。

> [!IMPORTANT]
> 本軟體按**「現狀」**提供，不附帶任何形式的保證。作者對因使用本工具而產生的任何資料遺失、安全事件或損害**概不負責**。使用風險自負。完整條款請參閱 [LICENSE](../../LICENSE)。

<br>

## 前置需求

| | Version / Requirement |
|---|---|
| macOS | 建議 13+ |
| Node.js | 18+（hook 腳本為 `.mjs` ES Modules，零外部依賴） |
| Bash | 3.2+（macOS 預設） |
| Git | 2.x+。須支援 `git pull --rebase` / `git push` |
| GitHub CLI | 選用（`gh` 可簡化 private repo 建立） |
| Claude Code | 需要 **Max 方案**（使用 `claude` CLI 和 `~/.claude/settings.json` 中的 Hook 系統） |
| Obsidian | 在任意資料夾建立一個 Vault（不需要 iCloud Drive） |
| jq | 1.6+（`install-hooks.sh --apply` 使用） |
| 環境變數 | `OBSIDIAN_VAULT` 指向 Vault 根目錄 |

<br>

## 快速開始

> [!WARNING]
> **安裝前請先了解：** claude-brain 會 hook 進**所有 Claude Code 工作階段的 I/O**。這意味著：
> - 工作階段日誌可能包含來自您的提示詞和工具輸出中的 **API 金鑰、令牌或個人資訊**。遮罩涵蓋主要模式，但並非完全——請參閱 [SECURITY.md](SECURITY.md)
> - 如果 `.gitignore` 設定錯誤，工作階段日誌可能會**意外推送到 GitHub**
> - 自動 Ingest 管線會透過 `claude -p` 將工作階段日誌內容傳送給 Claude 進行 Wiki 提取
>
> 建議先使用 `KIOKU_DRY_RUN=1` 驗證管線運作，然後再啟用完整操作。

### 🚀 互動式設定（推薦）

> [!NOTE]
> 在 Claude Code 中輸入以下指令，開始互動式引導設定。它會解釋每個步驟的目的，並根據您的環境進行調整。

```
Please read tools/claude-brain/skills/setup-guide/SKILL.md and guide me through the claude-brain installation.
```

### 🛠️ 手動設定

> [!NOTE]
> 適合想要了解每個步驟的使用者。直接執行腳本。

#### 1. 建立 Vault 並連接 Git 儲存庫（手動）

1. 在 Obsidian 中建立新的 Vault（例如 `~/claude-brain/main-claude-brain`）
2. 在 GitHub 上建立 Private 儲存庫（例如 `claude-brain`）
3. 在 Vault 目錄中：`git init && git remote add origin ...`（或 `gh repo create --private --source=. --push`）

此步驟不由 claude-brain 腳本自動化。GitHub 認證（gh CLI / SSH 金鑰）取決於您的環境。

#### 2. 設定環境變數

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

#### 3. 初始化 Vault

```bash
# Creates raw-sources/, session-logs/, wiki/, templates/ under the Vault,
# places CLAUDE.md / .gitignore / initial templates (never overwrites existing files)
bash tools/claude-brain/scripts/setup-vault.sh
```

#### 4. 安裝 Hooks

```bash
# Option A: Auto-merge (recommended, requires jq)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# Creates backup → shows diff → confirmation prompt → adds hook entries preserving existing config

# Option B: Manual merge
bash tools/claude-brain/scripts/install-hooks.sh
# Outputs JSON snippet to stdout for manual merge into ~/.claude/settings.json
```

#### 5. 驗證

重新啟動 Claude Code，然後進行一次對話。
應該會出現 `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md`。

> **步驟 1–5 為必要步驟。** 以下為選用，但建議啟用以獲得完整功能。

#### 6. 設定排程執行（建議）

配置自動 Ingest（每日）和 Lint（每月）。

```bash
# Auto-detects OS: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# Test with DRY RUN first
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **macOS 注意事項**：將儲存庫放在 `~/Documents/` 或 `~/Desktop/` 下可能導致 TCC（Transparency, Consent, Control）以 EPERM 阻擋背景存取。請使用受保護目錄以外的路徑（例如 `~/_PROJECT/`）。

#### 7. 設定 qmd 搜尋引擎（選用）

啟用 MCP 驅動的全文和語義搜尋功能。

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

#### 8. 安裝 Wiki Ingest 技能（選用）

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

#### 9. 部署到其他機器

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Open ~/claude-brain/main-claude-brain/ as a Vault in Obsidian
# Repeat steps 2–6
```

<br>

## 目錄結構

```
tools/claude-brain/
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

## 環境變數

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | 無（必填） | Vault 根目錄。auto-ingest/lint 會回退至 `${HOME}/claude-brain/main-claude-brain` |
| `KIOKU_DRY_RUN` | `0` | 設為 `1` 可跳過 `claude -p` 呼叫（僅驗證路徑） |
| `KIOKU_NO_LOG` | 未設定 | 設為 `1` 可抑制 session-logger.mjs（防止 cron 子程序的遞迴日誌記錄） |
| `KIOKU_DEBUG` | 未設定 | 設為 `1` 可將除錯資訊輸出至 stderr 和 `session-logs/.claude-brain/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ingest 日誌輸出路徑（auto-lint 自我診斷會參照此路徑） |

### Node 版本管理器 PATH 設定

排程腳本（`auto-ingest.sh`、`auto-lint.sh`）從 cron / LaunchAgent 執行，不會繼承您互動式 shell 的 PATH。它們會將 Volta（`~/.volta/bin`）和 mise（`~/.local/share/mise/shims`）加入 PATH。**如果您使用 nvm / fnm / asdf 或其他版本管理器**，請編輯每個腳本頂部的 `export PATH=...` 行：

```bash
# nvm example
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# fnm example
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## 設計說明

- **工作階段日誌包含機密資訊**：提示詞和工具輸出可能包含 API 金鑰、令牌或個人識別資訊。`session-logger.mjs` 在寫入前會套用正規表達式遮罩
- **寫入範圍**：Hooks 僅寫入 `$OBSIDIAN_VAULT/session-logs/`。絕不觸碰 `raw-sources/`、`wiki/` 或 `templates/`
- **session-logs 不會進入 Git**：被 `.gitignore` 排除，將意外推送至 GitHub 的風險降至最低
- **無網路存取**：Hook 腳本（`session-logger.mjs`）不匯入 `http`/`https`/`net`/`dgram`。Git 同步由 Hook 設定中的 shell 單行指令處理
- **冪等性**：`setup-vault.sh` / `install-hooks.sh` 可多次執行而不會破壞現有檔案
- **不執行 git init**：`setup-vault.sh` 不會初始化 Git 儲存庫或新增遠端。GitHub 認證由使用者自行負責

<br>

## 多機器設定

claude-brain 的設計目標是透過 Git 同步**在多台機器之間共享單一 Wiki**。
作者使用雙 Mac 配置：MacBook（主要開發機）和 Mac mini（用於 Claude Code bypass permission 模式）。

多機器操作的要點：
- **`session-logs/` 保留在各機器本地**（被 `.gitignore` 排除）。每台機器的工作階段日誌獨立且不會推送至 Git
- **`wiki/` 透過 Git 同步**。任何機器的 Ingest 結果都會累積在同一個 Wiki 中
- **錯開各機器的 Ingest/Lint 執行時間**以避免 git push 衝突
- SessionEnd Hook 的自動 commit/push 在所有機器上啟用，但一般的程式碼工作階段只會寫入 `session-logs/`——git 操作只在 `wiki/` 被直接修改時觸發

參考：作者的雙 Mac 配置

| | MacBook（主要） | Mac mini（bypass） |
|---|---|---|
| 機密資訊 | 有 | 無 |
| `session-logs/` | 僅本地 | 僅本地 |
| `wiki/` | Git 同步 | Git 同步 |
| Ingest 排程 | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint 排程 | 每月 1 日 8:00 | 每月 2 日 8:00 |
| 排程器 | LaunchAgent | LaunchAgent |

> 如果您只使用一台機器，可以完全忽略本節。快速開始的步驟就是您所需要的全部。

<br>

## 安全性

claude-brain 是一個存取**所有 Claude Code 工作階段 I/O** 的 Hook 系統。
完整的安全設計請參閱 [SECURITY.md](SECURITY.md)。

### 防禦層級

| Layer | Description |
|---|---|
| **輸入驗證** | 檢查 `OBSIDIAN_VAULT` 路徑是否含有 shell 元字元和 JSON/XML 控制字元 |
| **遮罩** | API 金鑰（Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure）、Bearer/Basic 認證、URL 憑證、PEM 私鑰均以 `***` 取代 |
| **權限** | `session-logs/` 以 `0o700` 建立，日誌檔案以 `0o600` 建立。Hook 腳本設為 `chmod 755` |
| **.gitignore 防護** | 每次 git commit 前驗證 `.gitignore` 包含 `session-logs/` |
| **遞迴防護** | `KIOKU_NO_LOG=1` + cwd-in-vault 檢查（雙重防護）防止子程序的遞迴日誌記錄 |
| **LLM 權限限制** | auto-ingest / auto-lint 以 `--allowedTools Write,Read,Edit`（無 Bash）執行 `claude -p` |
| **定期掃描** | `scan-secrets.sh` 每月掃描 session-logs/ 中的已知令牌模式以偵測遮罩失敗 |

### 新增令牌模式

當您開始使用新的雲端服務時，請將其令牌模式同時新增至 `hooks/session-logger.mjs`（`MASK_RULES`）和 `scripts/scan-secrets.sh`（`PATTERNS`）。

### 回報漏洞

如果您發現安全問題，請透過 [SECURITY.md](SECURITY.md) 回報，而非透過公開的 Issues。

<br>

## 路線圖

### 近期
- [ ] **Ingest 品質調校** — 在 2 週的實際 Ingest 運行後，檢視並調整 Vault CLAUDE.md 中的選取標準
- [ ] **qmd 多語言搜尋** — 驗證非英文內容的語義搜尋準確度；如需要則更換嵌入模型（例如 `multilingual-e5-small`）
- [ ] **安全自動修復技能 (`/wiki-fix-safe`)** — 在人工批准下自動修復瑣碎的 Lint 問題（新增缺失的交叉連結、填補 frontmatter 缺漏）
- [ ] **Git 同步錯誤可見性** — 將 `git push` 失敗記錄至 `session-logs/.claude-brain/git-sync.log` 並在 auto-ingest 中顯示警告

### 中期
- [ ] **多 LLM 支援** — 將 auto-ingest/lint 中的 `claude -p` 替換為可插拔的 LLM 後端（OpenAI API、透過 Ollama 的本地模型等）
- [ ] **CI/CD** — 推送時透過 GitHub Actions 進行自動化測試
- [ ] **Lint diff 通知** — 與上次 lint 報告比較，僅顯示*新偵測到的*問題
- [ ] **index.json 的樂觀鎖定** — 防止多個 Claude Code 工作階段並行時的更新遺失

### 長期
- [ ] **晨間簡報** — 自動生成每日摘要（昨日的工作階段、待決事項、新洞見）為 `wiki/daily/YYYY-MM-DD.md`
- [ ] **專案感知的上下文注入** — 根據當前專案（基於 `cwd`）過濾 `wiki/index.md` 以保持在 10,000 字元限制內
- [ ] **技術棧推薦技能 (`/wiki-suggest-stack`)** — 根據累積的 Wiki 知識為新專案建議技術棧
- [ ] **團隊 Wiki** — 多人 Wiki 共享（每位成員的 session-logs 保留在本地；僅 wiki/ 透過 Git 共享）

> **注意**：claude-brain 目前需要 **Claude Code（Max 方案）**。Hook 系統（L0）和 Wiki 上下文注入是 Claude Code 專屬功能。Ingest/Lint 管線（L1/L2）可透過替換 `claude -p` 呼叫來搭配其他 LLM API 使用——這已列入未來增強計畫。

<br>

## 更新歷史

### 2026-04-23 — v0.5.0：機能 2.4 — PDF / MD / EPUB / DOCX 統一 ingest router

- **Phase 1** — `kioku_ingest_document` router：統一的 MCP 工具，依副檔名（`.pdf` / `.md` / `.epub` / `.docx`）分派至對應 handler。既有 `kioku_ingest_pdf` 轉為 deprecation alias，於 v0.5 – v0.7 期間保留；計畫於 v0.8 移除
- **Phase 2** — EPUB 取入：透過 yauzl 安全展開，內建 8 層防禦（zip-slip / symlink / 累計大小上限 / entry 數上限 / NFKC 檔名 / 巢狀 ZIP skip / XXE pre-scan / XHTML script sanitize）。依 spine 順序之章節會轉換為 Markdown chunk（`readability-extract` + `turndown`），儲存於 `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`；多章節 EPUB 另產生 `-index.md`。LLM 摘要透過 auto-ingest cron 非同步處理
- **Phase 3** — DOCX 取入（MVP）：採用 `mammoth + yauzl` 兩層架構（mammoth 內部 jszip 的攻擊面由 yauzl 的 8 層防禦預先守護）。`word/document.xml` / `docProps/core.xml` 均經過 XXE pre-scan（`assertNoDoctype`）。圖片（VULN-D004/D007）與 OLE embedded content（VULN-D006）於本版本暫不支援 — MVP 僅擷取本文 + 標題。Metadata 以 `--- DOCX METADATA ---` fence 包覆並標註為 **untrusted**，以區隔下游 LLM 摘要的 prompt injection 風險
- **Pre-release hotfix** — 修正 `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` 中的 argv regex 為 Unicode 感知（`\p{L}\p{N}`）；先前的 `\w`（僅 ASCII）會在 auto-ingest cron 路徑中靜默跳過 `論文.docx` / `日本語.epub` 等日文／中文檔名。EPUB 自 v0.4.0 起便潛伏此 regression，現已回溯修復（LEARN#6 cross-boundary drift）。此外，`meta` / `base` / `link` 已加入 `html-sanitize` 的 `DANGEROUS_TAGS`，作為未來 EPUB consumer path 的 defense-in-depth
- **Known issue（不適用）** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6)，medium) 影響 **XMLBuilder** API（XML writer）。本 codebase 於 `mcp/lib/xml-safe.mjs` 僅使用 **XMLParser**（XML reader），因此不受此漏洞影響。該依賴將於 **v0.5.1** 升級至 `fast-xml-parser@^5.7.0` 以清除 dependabot alert
- 測試：**158 項 Bash assertions + 完整 Node suite 全部綠燈**（extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30）。`npm audit` 針對 runtime dependencies 回報 **0 vulnerabilities**；red-hacker + blue-hacker 並行 `/security-review` 回報 **0 HIGH/CRITICAL**
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — 已附上 `kioku-wiki-0.5.0.mcpb`（9.2 MB）

### 2026-04-21 — v0.4.0：Tier A（安全性 + 維運）＋ Tier B（整潔度）全面翻修

- **A#1** — 將 `@mozilla/readability` 從 0.5 升級至 0.6（緩解 ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7)；144 個 production dependencies 通過 `npm audit` 清潔檢查）
- **A#2** — 於 `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd 新增 `git symbolic-ref -q HEAD` 守衛，防止 Vault 處於 detached-HEAD 狀態時失控 commit（修復前曾於某台機器觀察到 5 天偏移）
- **A#3** — 重構 `withLock`（hold time 由數分鐘縮短至數秒）、完全移除 `skipLock` API，並新增 orphan-PDF cleanup
- **B#1** — Hook 層再稽核（`session-logger.mjs`）：修復 3 項 MEDIUM findings（invisible-character bypass of masking、frontmatter 中的 YAML injection、`KIOKU_NO_LOG` strict-equality drift）
- **B#2** — 將 cron/setup 守衛一致性規範化為 `tests/cron-guard-parity.test.sh`（17 項 assertions），以強制 Category-A / Category-B env-override 慣例
- **B#3** — 透過 `check_github_side_lock`（α guard、120 秒預設窗口，可經 `KIOKU_SYNC_LOCK_MAX_AGE` 設定）防止 `sync-to-app.sh` 跨機器 race；由 `tests/sync-to-app.test.sh`（11 項 assertions）鎖定 regression 防線
- **B#8** — README i18n 一致性：所有 8 份 non-en/ja READMEs 新增 §10 MCP / §11 MCPB / Changelog 章節（+1384 行）
- 測試：**299 Node tests** ＋ **15 Bash suites / 415 assertions**，全部綠燈
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — 已附上 `.mcpb`

### 2026-04-17 — Phase N：Claude Desktop 用 MCPB 套件
- 新增 `mcp/manifest.json`（MCPB v0.4）與 `scripts/build-mcpb.sh`，可產生 `mcp/dist/kioku-wiki-<version>.mcpb`（約 3.2 MB）
- Claude Desktop 使用者只需拖放單一 `.mcpb` 檔案即可完成 MCP 伺服器安裝。`OBSIDIAN_VAULT` 透過安裝對話框中的目錄選擇器設定（使用者機器無須安裝 Node — 由 Desktop 內建執行階段啟動）
- 詳細說明請參考 [README.md](README.md) 或 [README.ja.md](README.ja.md)

### 2026-04-17 — Phase M：kioku-wiki MCP 伺服器
- 本機 stdio MCP 伺服器（`tools/claude-brain/mcp/`）提供六項工具 — `kioku_search`、`kioku_read`、`kioku_list`、`kioku_write_note`、`kioku_write_wiki`、`kioku_delete`
- Claude Desktop 與 Claude Code 現在皆可在不離開聊天介面的情況下瀏覽、搜尋與編輯 Wiki
- 設定說明請參考 [README.md](README.md) 或 [README.ja.md](README.ja.md)

### 2026-04-16 — Phase L：遷移至 macOS LaunchAgent
- 新派遣腳本 `scripts/install-schedule.sh` 自動判別 macOS LaunchAgent / Linux cron

<br>

## 授權

本專案採用 MIT 授權條款。詳情請參閱 [LICENSE](../../LICENSE)。

如上方「注意事項」所述，本軟體按「現狀」提供，不附帶任何形式的保證。

<br>

## 參考

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 本專案實現的原始概念
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — 官方 Hook 系統文件
- [Obsidian](https://obsidian.md/) — 作為 Wiki 檢視器使用的知識管理應用程式
- [qmd](https://github.com/tobi/qmd) — Markdown 本地搜尋引擎（BM25 + 向量搜尋）

<br>

## 作者

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

用程式碼和 AI 打造各種東西。自由工程師，入行十年。以前端為主，最近的主要工作流程是與 Claude 協同開發。

[歡迎追蹤](https://x.com/megaphone_tokyo)
