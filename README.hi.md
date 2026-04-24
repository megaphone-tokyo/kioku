## यह मैनुअल कई भाषाओं में उपलब्ध है

> [!NOTE]
> **🌐 अन्य भाषाएँ:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · 🇮🇳 **हिन्दी** · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code पिछले सेशन से मिले ज्ञान को भूलता जाता है।
claude-brain आपकी बातचीत को **स्वचालित रूप से Wiki में संचित** करता है और **अगले सेशन में उन्हें वापस लाता** है।

एक ही बात बार-बार समझाने की ज़रूरत नहीं। हर उपयोग के साथ बढ़ने वाला 'second brain' — आपके Claude के लिए।

<br>

### महत्वपूर्ण नोट्स

> [!CAUTION]
> claude-brain को वर्तमान में **Claude Code (Max plan)** की आवश्यकता है। Hook सिस्टम (L0) और Wiki कॉन्टेक्स्ट इंजेक्शन Claude Code-विशिष्ट सुविधाएँ हैं। Ingest/Lint पाइपलाइन (L1/L2) `claude -p` कॉल को बदलकर अन्य LLM API के साथ काम कर सकती है — यह भविष्य के संवर्धन के रूप में योजनाबद्ध है।

> [!WARNING]
> **इंस्टॉल करने से पहले समझें:** claude-brain **सभी Claude Code सेशन I/O** में hook करता है। इसका मतलब है:
> - सेशन लॉग में आपके प्रॉम्प्ट और टूल आउटपुट से **API keys, tokens, या व्यक्तिगत जानकारी** हो सकती है। मास्किंग प्रमुख पैटर्न को कवर करती है लेकिन संपूर्ण नहीं है — [SECURITY.md](SECURITY.md) देखें
> - यदि `.gitignore` गलत कॉन्फ़िगर किया गया है, तो सेशन लॉग **गलती से GitHub पर पुश** हो सकते हैं
> - ऑटो-इंजेस्ट पाइपलाइन Wiki निष्कर्षण के लिए `claude -p` के माध्यम से सेशन लॉग सामग्री Claude को भेजती है
>
> पूर्ण संचालन सक्षम करने से पहले पाइपलाइन को सत्यापित करने के लिए `KIOKU_DRY_RUN=1` से शुरू करने की अनुशंसा की जाती है।

> [!IMPORTANT]
> यह सॉफ़्टवेयर **"जैसा है"** प्रदान किया गया है, बिना किसी प्रकार की वारंटी के। लेखक इस टूल के उपयोग से उत्पन्न होने वाली किसी भी डेटा हानि, सुरक्षा घटना, या क्षति के लिए **कोई जिम्मेदारी नहीं** लेते हैं। अपने जोखिम पर उपयोग करें। पूर्ण शर्तों के लिए [LICENSE](../../LICENSE) देखें।

<br>

## यह क्या करता है

```
🗣️  हमेशा की तरह Claude Code से बात करें
         ↓  （सब कुछ स्वचालित रूप से रिकॉर्ड होता है — आपको कुछ नहीं करना）
📝  सेशन लॉग स्थानीय रूप से सहेजे जाते हैं
         ↓  （एक शेड्यूल्ड जॉब AI से लॉग पढ़वाकर ज्ञान निकालता है）
📚  Wiki हर सेशन के साथ बढ़ता है — अवधारणाएँ, निर्णय, पैटर्न
         ↓  （Git से सिंक）
☁️  GitHub आपकी Wiki का बैकअप रखता है और मशीनों के बीच साझा करता है
```

1. **स्वचालित कैप्चर (L0)**: Claude Code hook इवेंट (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) को कैप्चर करता है और `session-logs/` में Markdown लिखता है
2. **संरचना निर्माण (L1)**: शेड्यूल्ड एक्ज़ीक्यूशन (macOS LaunchAgent / Linux cron) द्वारा LLM अनप्रोसेस्ड लॉग पढ़ता है और `wiki/` में कॉन्सेप्ट पेज, प्रोजेक्ट पेज और डिज़ाइन निर्णय बनाता है। सेशन विश्लेषण `wiki/analyses/` में भी सहेजे जाते हैं
3. **अखंडता जांच (L2)**: मासिक wiki स्वास्थ्य जांच `wiki/lint-report.md` उत्पन्न करती है। स्वचालित सीक्रेट लीक डिटेक्शन शामिल है
4. **सिंक (L3)**: Vault स्वयं एक Git रिपॉजिटरी है। `SessionStart` पर `git pull` चलता है, `SessionEnd` पर `git commit && git push` चलता है, GitHub Private रिपॉजिटरी के माध्यम से मशीनों के बीच सिंक होता है
5. **Wiki कॉन्टेक्स्ट इंजेक्शन**: `SessionStart` पर `wiki/index.md` सिस्टम प्रॉम्प्ट में इंजेक्ट किया जाता है ताकि Claude पिछले ज्ञान का लाभ उठा सके
6. **qmd फ़ुल-टेक्स्ट सर्च**: MCP के माध्यम से BM25 + सिमैंटिक सर्च से wiki खोजें
7. **Wiki Ingest skills**: `/wiki-ingest-all` और `/wiki-ingest` स्लैश कमांड मौजूदा प्रोजेक्ट ज्ञान को Wiki में आयात करते हैं
8. **सीक्रेट आइसोलेशन**: `session-logs/` प्रत्येक मशीन पर लोकल रहता है (`.gitignore`)। केवल `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` Git-प्रबंधित हैं

<br>

## पूर्वापेक्षाएं

| | Version / Requirement |
|---|---|
| macOS | 13+ अनुशंसित |
| Node.js | 18+ (hook स्क्रिप्ट `.mjs` ES Modules हैं, शून्य बाहरी निर्भरताएं) |
| Bash | 3.2+ (macOS डिफ़ॉल्ट) |
| Git | 2.x+। `git pull --rebase` / `git push` का समर्थन आवश्यक |
| GitHub CLI | वैकल्पिक (`gh` प्राइवेट रिपो बनाना सरल बनाता है) |
| Claude Code | Hook सिस्टम (`~/.claude/settings.json`) समर्थन वाला संस्करण |
| Obsidian | किसी भी फ़ोल्डर में एक Vault बनाया हुआ (iCloud Drive आवश्यक नहीं) |
| jq | 1.6+ (`install-hooks.sh --apply` द्वारा उपयोग किया जाता है) |
| Env var | `OBSIDIAN_VAULT` Vault रूट की ओर इंगित करता हुआ |

<br>

## त्वरित प्रारंभ

### 1. Vault बनाएं और इसे Git रिपॉजिटरी से जोड़ें (मैनुअल)

1. Obsidian में एक नया Vault बनाएं (उदा., `~/claude-brain/main-claude-brain`)
2. GitHub पर एक Private रिपॉजिटरी बनाएं (उदा., `claude-brain`)
3. Vault डायरेक्टरी में: `git init && git remote add origin ...` (या `gh repo create --private --source=. --push`)

यह चरण claude-brain स्क्रिप्ट द्वारा स्वचालित नहीं है। GitHub प्रमाणीकरण (gh CLI / SSH keys) आपके परिवेश पर निर्भर करता है।

### 2. एनवायरनमेंट वेरिएबल सेट करें

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

### 3. Vault को इनिशियलाइज़ करें

```bash
# Creates raw-sources/, session-logs/, wiki/, templates/ under the Vault,
# places CLAUDE.md / .gitignore / initial templates (never overwrites existing files)
bash tools/claude-brain/scripts/setup-vault.sh
```

### 4. Hooks इंस्टॉल करें

```bash
# Option A: Auto-merge (recommended, requires jq)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# Creates backup → shows diff → confirmation prompt → adds hook entries preserving existing config

# Option B: Manual merge
bash tools/claude-brain/scripts/install-hooks.sh
# Outputs JSON snippet to stdout for manual merge into ~/.claude/settings.json
```

### 5. सत्यापन करें

Claude Code पुनः प्रारंभ करें, फिर एक वार्तालाप करें।
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` बनना चाहिए।

### 6. शेड्यूल्ड एक्ज़ीक्यूशन सेटअप करें (अनुशंसित)

स्वचालित Ingest (दैनिक) और Lint (मासिक) कॉन्फ़िगर करें।

```bash
# Auto-detects OS: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# Test with DRY RUN first
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **macOS नोट**: रिपो को `~/Documents/` या `~/Desktop/` के अंतर्गत रखने से TCC (Transparency, Consent, Control) बैकग्राउंड एक्सेस को EPERM के साथ ब्लॉक कर सकता है। संरक्षित डायरेक्टरी के बाहर पथ का उपयोग करें (उदा., `~/_PROJECT/`)।

### 7. qmd सर्च इंजन सेटअप करें (वैकल्पिक)

Wiki के लिए MCP-संचालित फ़ुल-टेक्स्ट और सिमैंटिक सर्च सक्षम करें।

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

### 8. Wiki Ingest skills इंस्टॉल करें (वैकल्पिक)

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

### 9. अतिरिक्त मशीनों पर डिप्लॉय करें

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Open ~/claude-brain/main-claude-brain/ as a Vault in Obsidian
# Repeat steps 2–6
```

<br>

## डायरेक्टरी संरचना

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

## एनवायरनमेंट वेरिएबल

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | none (आवश्यक) | Vault रूट। auto-ingest/lint `${HOME}/claude-brain/main-claude-brain` पर फ़ॉलबैक करते हैं |
| `KIOKU_DRY_RUN` | `0` | `1` से `claude -p` कॉल स्किप होते हैं (केवल पथ सत्यापन) |
| `KIOKU_NO_LOG` | unset | `1` से session-logger.mjs दबाया जाता है (cron सबप्रोसेस से रिकर्सिव लॉगिंग रोकता है) |
| `KIOKU_DEBUG` | unset | `1` से stderr और `session-logs/.claude-brain/errors.log` में डिबग जानकारी उत्सर्जित होती है |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ingest लॉग आउटपुट पथ (auto-lint सेल्फ-डायग्नोस्टिक्स द्वारा संदर्भित) |

### Node Version Manager PATH सेटअप

शेड्यूल्ड स्क्रिप्ट (`auto-ingest.sh`, `auto-lint.sh`) cron / LaunchAgent से चलती हैं और आपके इंटरैक्टिव शेल का PATH इनहेरिट नहीं करतीं। ये Volta (`~/.volta/bin`) और mise (`~/.local/share/mise/shims`) को PATH में जोड़ती हैं। **यदि आप nvm / fnm / asdf या कोई अन्य वर्शन मैनेजर उपयोग करते हैं**, तो प्रत्येक स्क्रिप्ट के शीर्ष पर `export PATH=...` पंक्ति संपादित करें:

```bash
# nvm example
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# fnm example
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## डिज़ाइन नोट्स

- **सेशन लॉग में सीक्रेट होते हैं**: प्रॉम्प्ट और टूल आउटपुट में API keys, tokens, या PII शामिल हो सकते हैं। `session-logger.mjs` लिखने से पहले regex मास्किंग लागू करता है
- **लेखन सीमा**: Hooks केवल `$OBSIDIAN_VAULT/session-logs/` में लिखते हैं। वे कभी `raw-sources/`, `wiki/`, या `templates/` को नहीं छूते
- **session-logs कभी Git तक नहीं पहुंचते**: `.gitignore` द्वारा बाहर रखे गए हैं, जिससे GitHub पर आकस्मिक पुश का जोखिम न्यूनतम होता है
- **कोई नेटवर्क एक्सेस नहीं**: Hook स्क्रिप्ट (`session-logger.mjs`) `http`/`https`/`net`/`dgram` आयात नहीं करती। Git सिंक Hook कॉन्फ़िग में शेल वन-लाइनर द्वारा संभाला जाता है
- **इडेम्पोटेंट**: `setup-vault.sh` / `install-hooks.sh` को मौजूदा फ़ाइलों को नष्ट किए बिना कई बार चलाया जा सकता है
- **कोई git init नहीं**: `setup-vault.sh` Git रिपो इनिशियलाइज़ या रिमोट जोड़ने का काम नहीं करता। GitHub प्रमाणीकरण उपयोगकर्ता की जिम्मेदारी है

<br>

## सुरक्षा

claude-brain एक Hook सिस्टम है जो **सभी Claude Code सेशन I/O** तक पहुंच रखता है।
पूर्ण सुरक्षा डिज़ाइन के लिए [SECURITY.md](SECURITY.md) देखें।

### रक्षा परतें

| Layer | Description |
|---|---|
| **इनपुट सत्यापन** | `OBSIDIAN_VAULT` पथ की शेल मेटाकैरेक्टर और JSON/XML कंट्रोल कैरेक्टर के लिए जांच |
| **मास्किंग** | API keys (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), Bearer/Basic auth, URL क्रेडेंशियल, PEM प्राइवेट keys को `***` से बदला जाता है |
| **अनुमतियां** | `session-logs/` `0o700` के साथ बनाई जाती है, लॉग फ़ाइलें `0o600` के साथ। Hook स्क्रिप्ट `chmod 755` पर सेट |
| **.gitignore गार्ड** | हर git commit से पहले `.gitignore` में `session-logs/` की उपस्थिति सत्यापित करता है |
| **रिकर्शन रोकथाम** | `KIOKU_NO_LOG=1` + cwd-in-vault जांच (दोहरी सुरक्षा) सबप्रोसेस से रिकर्सिव लॉगिंग रोकती है |
| **LLM अनुमति प्रतिबंध** | auto-ingest / auto-lint `claude -p` को `--allowedTools Write,Read,Edit` (कोई Bash नहीं) के साथ चलाते हैं |
| **आवधिक स्कैनिंग** | `scan-secrets.sh` मासिक रूप से session-logs/ को ज्ञात टोकन पैटर्न के लिए स्कैन करता है ताकि मास्किंग विफलताओं का पता लगाया जा सके |

### टोकन पैटर्न जोड़ना

जब आप किसी नई क्लाउड सेवा का उपयोग शुरू करें, तो उसके टोकन पैटर्न को `hooks/session-logger.mjs` (`MASK_RULES`) और `scripts/scan-secrets.sh` (`PATTERNS`) दोनों में जोड़ें।

### कमजोरियों की रिपोर्टिंग

यदि आपको कोई सुरक्षा समस्या मिलती है, तो कृपया इसे [SECURITY.md](SECURITY.md) के माध्यम से रिपोर्ट करें -- सार्वजनिक Issues के माध्यम से नहीं।

<br>

## परिवर्तन इतिहास

### 2026-04-24 — v0.6.0: Ecosystem expansion — multi-agent + plugin marketplace + Bases dashboard + delta tracking + security hardening

v0.6.0 Phase C को consolidate करता है।

- **Multi-agent cross-platform (C-1)** — `scripts/setup-multi-agent.sh` Codex CLI / OpenCode / Gemini CLI में KIOKU skills symlink। 19/19 Bash assertions
- **Claude Code plugin marketplace (C-2)** — `claude marketplace add megaphone-tokyo/kioku && claude plugin install kioku@megaphone-tokyo` से install
- **Raw MD sha256 delta tracking (C-3)** — `raw-sources/<subdir>/*.md` के MD files भी sha256 delta detection में participate। 82/82 auto-ingest assertions
- **Obsidian Bases dashboard (C-4)** — `templates/wiki/meta/dashboard.base` में 9 views
- **Visualizer foundations (V-1, v0.7 preparation)** — `mcp/lib/git-history.mjs` + `mcp/lib/wiki-snapshot.mjs`, 14/14 Node assertions
- **Security policy upgrade (C-5a)** — `SECURITY.md` में CVE Classification / Safe Harbor / Coordinated Disclosure Timeline। `SECURITY.ja.md` 4/7 sections
- **Community channel pivot** — Dedicated Discord dropped, GitHub Discussions canonical
- **Organizational learnings** — LEARN#10 (PM handoff script verify mandatory)
- **v0.7+ deferred** — Visualizer HTML UI, LP β, GitHub Discussions enable, SECURITY.ja remaining 3 sections
- परीक्षण: **Node 264/264 + Bash 400+/400+ green**
- [Release v0.6.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.6.0) — `kioku-wiki-0.6.0.mcpb` (~9 MB)

### 2026-04-23 — v0.5.1: Hot cache + PostCompact hook + opt-in Stop prompt

- **Hot cache pattern** — नया `wiki/hot.md` (<=500 शब्द, hard cap 4000 वर्ण) **SessionStart** पर auto-inject होता है और **PostCompact** (context compaction) के बाद फिर से inject होता है, ताकि LLM sessions और compactions के बीच अल्पकालिक कार्य context बनाए रखे। claude-obsidian के UX pattern से प्रेरित
- **PostCompact hook** — `install-hooks.sh` अब छठा event (`PostCompact`) जोड़ता है जो केवल hot.md को फिर से inject करता है (compaction के बाद index.md पहले से context में है, इसलिए token bloat से बचने के लिए छोड़ा जाता है)
- **Opt-in Stop prompt** (`KIOKU_HOT_AUTO_PROMPT=1`) — स्पष्ट रूप से set करने पर session समाप्ति पर hot.md update सुझाव prompt आता है। **Default OFF** — hot.md Git-synced है और session-logs से कड़ी security boundary है, इसलिए auto-prompt के लिए user की स्पष्ट सहमति चाहिए
- **Security boundary बनाए रखी गई** — hot.md injection से पहले `applyMasks()` (API key / token pattern masking) से गुजरता है, scan-secrets.sh walk target में है, `realpath` के माध्यम से symlink escape अस्वीकार करता है (vault के बाहर path अस्वीकृत), और WARN log के साथ 4000 वर्णों पर truncate करता है
- **Claude Code v2 hook schema alignment (4 hotfixes)** — Claude Code v2 event के अनुसार अलग output schemas उपयोग करता है: `hookSpecificOutput` केवल `PreToolUse` / `UserPromptSubmit` / `PostToolUse` के लिए समर्थित है; `PostCompact` और `Stop` को top-level `systemMessage` उपयोग करना चाहिए। पुराना v1 flat `{additionalContext}` v2 में silently discard होता है। Hotfixes 1-4 सभी hook output को प्रति-event सही schema में migrate करते हैं
- परीक्षण: **47 Node assertions** (HOT-1..9d + HOT-V1/V2 + session-logger regression + injector H1-H5) **+ 488 Bash assertions** (IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 15 मौजूदा suites), सभी green
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` संलग्न (9.2 MB)

### 2026-04-23 — v0.5.0: फ़ीचर 2.4 — PDF / MD / EPUB / DOCX एकीकृत ingest router

- **Phase 1** — `kioku_ingest_document` router: एक एकीकृत MCP टूल जो फ़ाइल एक्सटेंशन (`.pdf` / `.md` / `.epub` / `.docx`) के अनुसार संबंधित handler को dispatch करता है। मौजूदा `kioku_ingest_pdf` deprecation alias बन गया है और v0.5 – v0.7 विंडो में बरकरार रखा जाएगा; v0.8 में हटाने की योजना है
- **Phase 2** — EPUB ingest: yauzl के माध्यम से सुरक्षित extraction, 8-परत रक्षा के साथ (zip-slip / symlink / संचयी आकार सीमा / entry संख्या सीमा / NFKC फ़ाइलनाम / nested ZIP skip / XXE pre-scan / XHTML script sanitize)। Spine-क्रम में अध्यायों को `readability-extract` + `turndown` के ज़रिए Markdown chunks में बदला जाता है और `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md` में संग्रहित किया जाता है; बहु-अध्याय EPUB के लिए `-index.md` भी बनता है। LLM summary auto-ingest cron के माध्यम से asynchronous रूप से प्रवाहित होती है
- **Phase 3** — DOCX ingest (MVP): `mammoth + yauzl` दो-परत आर्किटेक्चर (mammoth के आंतरिक jszip की attack surface को yauzl की 8-परत रक्षा से पहले ही सुरक्षित कर दिया जाता है)। `word/document.xml` / `docProps/core.xml` XXE pre-scan (`assertNoDoctype`) से गुज़रते हैं। छवियाँ (VULN-D004/D007) और OLE embedded content (VULN-D006) स्थगित — MVP केवल body text + headings निकालता है। Metadata को `--- DOCX METADATA ---` fence में घेरा जाता है और **untrusted** के रूप में चिह्नित किया जाता है ताकि downstream LLM summarization के विरुद्ध prompt injection की सीमा स्पष्ट हो
- **Pre-release hotfix** — `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` के argv regex को Unicode-aware बनाने के लिए ठीक किया (`\p{L}\p{N}`); पिछला `\w` (केवल ASCII) auto-ingest cron path में `論文.docx` / `日本語.epub` जैसे जापानी/चीनी फ़ाइलनामों को silently skip कर देता था। EPUB v0.4.0 से इस latent regression में था और retroactively ठीक किया गया (LEARN#6 cross-boundary drift)। इसके अतिरिक्त भविष्य के EPUB consumer paths के लिए defense-in-depth के रूप में `meta` / `base` / `link` को `html-sanitize` के `DANGEROUS_TAGS` में जोड़ा गया
- **Known issue (लागू नहीं)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium) **XMLBuilder** API (XML writer) को लक्षित करता है। यह codebase `mcp/lib/xml-safe.mjs` में केवल **XMLParser** (XML reader) का उपयोग करता है, इसलिए यह vulnerability exploit करने योग्य नहीं है। dependabot alert को clear करने के लिए **v0.5.1** में dependency को `fast-xml-parser@^5.7.0` पर अपग्रेड किया जाएगा
- टेस्ट: **158 Bash assertions + पूर्ण Node suite सभी green** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30)। `npm audit` runtime dependencies पर **0 vulnerabilities** रिपोर्ट करता है; red-hacker + blue-hacker समानांतर `/security-review` **0 HIGH/CRITICAL** findings रिपोर्ट करता है
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` attached (9.2 MB)

### 2026-04-21 — v0.4.0: Tier A (security + ops) + Tier B (cleanness) ओवरहॉल

- **A#1** — `@mozilla/readability` को 0.5 → 0.6 पर अपग्रेड किया (ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7) शमित; 144 production dependencies `npm audit` clean पास करती हैं)
- **A#2** — `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd में `git symbolic-ref -q HEAD` गार्ड जोड़ा, जो Vault के detached-HEAD state में होने पर runaway commits को रोकता है (एक मशीन पर fix से पहले 5-day drift देखा गया)
- **A#3** — `withLock` को रिफैक्टर किया (hold time को मिनटों से सेकंडों तक घटाया), `skipLock` API को पूरी तरह हटाया, और orphan-PDF cleanup जोड़ा
- **B#1** — Hook layer re-audit (`session-logger.mjs`): 3 MEDIUM findings ठीक किए (masking का invisible-character bypass, frontmatter में YAML injection, `KIOKU_NO_LOG` strict-equality drift)
- **B#2** — cron/setup गार्ड parity को `tests/cron-guard-parity.test.sh` (17 assertions) के रूप में औपचारिक किया ताकि Category-A / Category-B env-override conventions लागू हों
- **B#3** — `sync-to-app.sh` cross-machine race को `check_github_side_lock` (α guard, 120s default window, `KIOKU_SYNC_LOCK_MAX_AGE` के माध्यम से configurable) द्वारा रोका गया; regression `tests/sync-to-app.test.sh` (11 assertions) में लॉक किया गया
- **B#8** — README i18n parity: §10 MCP / §11 MCPB / Changelog sections सभी 8 non-en/ja READMEs में जोड़े गए (+1384 lines)
- Tests: **299 Node tests** + **15 Bash suites / 415 assertions**, सभी green
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` attached

### 2026-04-17 — Phase N: Claude Desktop के लिए MCPB बंडल
- नया `mcp/manifest.json` (MCPB v0.4) और `scripts/build-mcpb.sh` `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 MB) बनाते हैं
- Claude Desktop उपयोगकर्ता एक `.mcpb` फ़ाइल को drag-and-drop करके MCP सर्वर इंस्टॉल कर सकते हैं। `OBSIDIAN_VAULT` को इंस्टॉल डायलॉग में directory picker से कॉन्फ़िगर करें (उपयोगकर्ता के मशीन पर Node की आवश्यकता नहीं — Desktop का बंडल किया हुआ runtime उपयोग होता है)
- विस्तृत निर्देशों के लिए [README.md](README.md) या [README.ja.md](README.ja.md) देखें

### 2026-04-17 — Phase M: kioku-wiki MCP सर्वर
- लोकल stdio MCP सर्वर (`tools/claude-brain/mcp/`) छह टूल्स प्रदान करता है — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- अब Claude Desktop और Claude Code दोनों चैट छोड़े बिना Wiki को ब्राउज़, खोज और अपडेट कर सकते हैं
- सेटअप निर्देशों के लिए [README.md](README.md) या [README.ja.md](README.ja.md) देखें

### 2026-04-16 — Phase L: macOS LaunchAgent में माइग्रेशन
- नया dispatcher `scripts/install-schedule.sh` स्वचालित रूप से macOS LaunchAgent या Linux cron चुनता है

<br>

## संदर्भ

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — मूल अवधारणा जिसे यह प्रोजेक्ट लागू करता है
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — आधिकारिक Hook सिस्टम दस्तावेज़ीकरण
- [Obsidian](https://obsidian.md/) — Wiki व्यूअर के रूप में उपयोग किया जाने वाला ज्ञान प्रबंधन ऐप
- [qmd](https://github.com/tobi/qmd) — Markdown के लिए लोकल सर्च इंजन (BM25 + वेक्टर सर्च)

## लेखक

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

कोड और AI से चीज़ें बनाता हूँ। फ्रीलांस इंजीनियर, 10 साल का अनुभव। फ्रंटएंड पर फोकस, हाल ही में Claude के साथ को-डेवलपमेंट मेरा मुख्य वर्कफ़्लो है।

[फ़ॉलो करें](https://x.com/megaphone_tokyo)
