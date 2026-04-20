## यह मैनुअल कई भाषाओं में उपलब्ध है

> [!NOTE]
> **🌐 अन्य भाषाएँ:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · 🇮🇳 **हिन्दी** · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code पिछले सेशन से प्राप्त ज्ञान को भूलता जाता है।
KIOKU आपकी Claude के साथ बातचीत की याद को **स्वचालित रूप से Wiki में संचित** करता है और **अगले सेशन में वापस लाता** है।

बार-बार वही बात समझाने की ज़रूरत नहीं। हर उपयोग के साथ बढ़ने वाला "second brain" — आपके Claude के लिए।

<br>

## यह क्या करता है

Claude Code के सेशन को स्वचालित रूप से रिकॉर्ड करता है और Obsidian Vault पर एक संरचित ज्ञानकोश बनाता है।

Andrej Karpathy के LLM Wiki पैटर्न को स्वचालित लॉग संग्रह और Git सिंक के साथ जोड़कर, कई मशीनों के बीच साझा करने योग्य बनाया गया है।

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
7. **बाहरी स्रोत इंजेस्ट (PDF / URL)**: `kioku_ingest_pdf` `raw-sources/` के अंतर्गत रखे गए लोकल PDF को निकालकर सारांशित करता है; `kioku_ingest_url` HTTP(S) लेखों को Mozilla Readability के साथ फ़ेच करता है, Markdown + छवियों को `raw-sources/<subdir>/fetched/` में सहेजता है, और PDF URLs को स्वचालित रूप से PDF पाइपलाइन को भेजता है। बड़े PDF (≥ 2 chunks) ≤ 5 s में वापसी के लिए detached सारांश प्रक्रिया का उपयोग करते हैं (Claude Desktop 60 s timeout safe)
8. **Wiki Ingest skills**: `/wiki-ingest-all` और `/wiki-ingest` स्लैश कमांड मौजूदा प्रोजेक्ट ज्ञान को Wiki में आयात करते हैं
9. **सीक्रेट आइसोलेशन**: `session-logs/` प्रत्येक मशीन पर लोकल रहता है (`.gitignore`)। केवल `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` Git-प्रबंधित हैं

<br>

## महत्वपूर्ण नोट्स

> [!CAUTION]
> KIOKU को वर्तमान में **Claude Code (Max plan)** की आवश्यकता है। Hook सिस्टम (L0) और Wiki कॉन्टेक्स्ट इंजेक्शन Claude Code-विशिष्ट सुविधाएँ हैं। Ingest/Lint पाइपलाइन (L1/L2) `claude -p` कॉल को बदलकर अन्य LLM API के साथ काम कर सकती है — यह भविष्य के संवर्धन के रूप में योजनाबद्ध है।

> [!IMPORTANT]
> यह सॉफ़्टवेयर **"जैसा है"** प्रदान किया गया है, बिना किसी प्रकार की वारंटी के। लेखक इस टूल के उपयोग से उत्पन्न होने वाली किसी भी डेटा हानि, सुरक्षा घटना, या क्षति के लिए **कोई जिम्मेदारी नहीं** लेते हैं। अपने जोखिम पर उपयोग करें। पूर्ण शर्तों के लिए [LICENSE](LICENSE) देखें।

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

> [!WARNING]
> **इंस्टॉल करने से पहले समझें:** KIOKU **सभी Claude Code सेशन I/O** में hook करता है। इसका मतलब है:
> - सेशन लॉग में आपके प्रॉम्प्ट और टूल आउटपुट से **API keys, tokens, या व्यक्तिगत जानकारी** हो सकती है। मास्किंग प्रमुख पैटर्न को कवर करती है लेकिन संपूर्ण नहीं है — [SECURITY.md](SECURITY.md) देखें
> - यदि `.gitignore` गलत कॉन्फ़िगर किया गया है, तो सेशन लॉग **गलती से GitHub पर पुश** हो सकते हैं
> - ऑटो-इंजेस्ट पाइपलाइन Wiki निष्कर्षण के लिए `claude -p` के माध्यम से सेशन लॉग सामग्री Claude को भेजती है
>
> पूर्ण संचालन सक्षम करने से पहले पाइपलाइन को सत्यापित करने के लिए `KIOKU_DRY_RUN=1` से शुरू करने की अनुशंसा की जाती है।

### 🚀 इंटरैक्टिव सेटअप (अनुशंसित)

> [!NOTE]
> Claude Code में निम्नलिखित दर्ज करें, जिससे इंटरैक्टिव सेटअप शुरू होगा। प्रत्येक चरण का अर्थ और उद्देश्य समझाते हुए, आपके वातावरण के अनुसार मार्गदर्शन किया जाएगा।

```
skills/setup-guide/SKILL.md を参照して、KIOKU のインストール作業をしてください。
```

### 🛠️ मैनुअल सेटअप

> [!NOTE]
> प्रत्येक चरण को स्वयं समझते हुए आगे बढ़ना चाहने वालों के लिए। स्क्रिप्ट सीधे चलाएं।

#### 1. Vault बनाएं और इसे Git रिपॉजिटरी से जोड़ें (मैनुअल)

1. Obsidian में एक नया Vault बनाएं (उदा., `~/kioku/main-kioku`)
2. GitHub पर एक Private रिपॉजिटरी बनाएं (उदा., `kioku`)
3. Vault डायरेक्टरी में: `git init && git remote add origin ...` (या `gh repo create --private --source=. --push`)

यह चरण KIOKU स्क्रिप्ट द्वारा स्वचालित नहीं है। GitHub प्रमाणीकरण (gh CLI / SSH keys) आपके परिवेश पर निर्भर करता है।

#### 2. एनवायरनमेंट वेरिएबल सेट करें

```bash
# Add to ~/.zshrc or ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Vault को इनिशियलाइज़ करें

```bash
# Creates raw-sources/, session-logs/, wiki/, templates/ under the Vault,
# places CLAUDE.md / .gitignore / initial templates (never overwrites existing files)
bash scripts/setup-vault.sh
```

#### 4. Hooks इंस्टॉल करें

```bash
# Option A: Auto-merge (recommended, requires jq)
bash scripts/install-hooks.sh --apply
# Creates backup → shows diff → confirmation prompt → adds hook entries preserving existing config

# Option B: Manual merge
bash scripts/install-hooks.sh
# Outputs JSON snippet to stdout for manual merge into ~/.claude/settings.json
```

#### 5. सत्यापन करें

Claude Code पुनः प्रारंभ करें, फिर एक वार्तालाप करें।
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` बनना चाहिए।

> **यहाँ तक अनिवार्य चरण हैं।** नीचे वैकल्पिक हैं, लेकिन पूर्ण उपयोग के लिए सेटअप की अनुशंसा है।

#### 6. शेड्यूल्ड एक्ज़ीक्यूशन सेटअप करें (अनुशंसित)

स्वचालित Ingest (दैनिक) और Lint (मासिक) कॉन्फ़िगर करें।

```bash
# Auto-detects OS: macOS → LaunchAgent, Linux → cron
bash scripts/install-schedule.sh

# Test with DRY RUN first
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **macOS नोट**: रिपो को `~/Documents/` या `~/Desktop/` के अंतर्गत रखने से TCC (Transparency, Consent, Control) बैकग्राउंड एक्सेस को EPERM के साथ ब्लॉक कर सकता है। संरक्षित डायरेक्टरी के बाहर पथ का उपयोग करें (उदा., `~/_PROJECT/`)।

मैन्युअल रूप से एक बार चलाने के लिए, स्क्रिप्ट को सीधे निष्पादित करें — वही प्रोसेसिंग चलेगी।

#### 7. qmd सर्च इंजन सेटअप करें (वैकल्पिक)

Wiki के लिए MCP-संचालित फ़ुल-टेक्स्ट और सिमैंटिक सर्च सक्षम करें।

```bash
# qmd कलेक्शन रजिस्ट्रेशन + प्रारंभिक इंडेक्सिंग
bash scripts/setup-qmd.sh

# qmd MCP HTTP सर्वर को launchd में स्थापित करें (केवल macOS)
bash scripts/install-qmd-daemon.sh
```

#### 8. Wiki Ingest skills इंस्टॉल करें (वैकल्पिक)

`/wiki-ingest-all` (मौजूदा प्रोजेक्ट बैच इंपोर्ट) और `/wiki-ingest` (टार्गेट स्कैन) सक्षम करें।

```bash
# ~/.claude/skills/ में symlink बनाएं
bash scripts/install-skills.sh
```

#### 9. अतिरिक्त मशीनों पर डिप्लॉय करें

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Open ~/kioku/main-kioku/ as a Vault in Obsidian
# Repeat steps 2–6
```

<br>

## डायरेक्टरी संरचना

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

## एनवायरनमेंट वेरिएबल

| Variable | Default | Purpose |
|---|---|---|
| `OBSIDIAN_VAULT` | none (आवश्यक) | Vault रूट। auto-ingest/lint `${HOME}/kioku/main-kioku` पर फ़ॉलबैक करते हैं |
| `KIOKU_DRY_RUN` | `0` | `1` से `claude -p` कॉल स्किप होते हैं (केवल पथ सत्यापन) |
| `KIOKU_NO_LOG` | unset | `1` से session-logger.mjs दबाया जाता है (cron सबप्रोसेस से रिकर्सिव लॉगिंग रोकता है) |
| `KIOKU_DEBUG` | unset | `1` से stderr और `session-logs/.kioku/errors.log` में डिबग जानकारी उत्सर्जित होती है |
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

KIOKU एक Hook सिस्टम है जो **सभी Claude Code सेशन I/O** तक पहुंच रखता है।
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

## मल्टी-मशीन सेटअप

KIOKU को Git सिंक के माध्यम से **कई मशीनों में एक ही Wiki साझा** करने के लिए डिज़ाइन किया गया है।
लेखक दो-Mac सेटअप चलाता है: एक MacBook (प्राथमिक डेव मशीन) और एक Mac mini (Claude Code bypass permission मोड के लिए)।

मल्टी-मशीन संचालन के मुख्य बिंदु:
- **`session-logs/` प्रत्येक मशीन पर लोकल रहता है** (`.gitignore` द्वारा बाहर रखा गया)। प्रत्येक मशीन के सेशन लॉग स्वतंत्र हैं और कभी Git पर पुश नहीं होते
- **`wiki/` Git-सिंक्ड है**। किसी भी मशीन के Ingest परिणाम एक ही Wiki में संचित होते हैं
- **मशीनों के बीच Ingest/Lint निष्पादन समय अलग-अलग रखें** ताकि git push टकराव से बचा जा सके
- SessionEnd Hook ऑटो commit/push सभी मशीनों पर सक्षम है, लेकिन सामान्य कोडिंग सेशन केवल `session-logs/` में लिखते हैं — git ऑपरेशन केवल तभी ट्रिगर होते हैं जब `wiki/` सीधे संशोधित किया जाता है

संदर्भ: लेखक का दो-Mac कॉन्फ़िगरेशन

| | MacBook (प्राथमिक) | Mac mini (bypass) |
|---|---|---|
| सीक्रेट्स | हाँ | नहीं |
| `session-logs/` | केवल लोकल | केवल लोकल |
| `wiki/` | Git-सिंक्ड | Git-सिंक्ड |
| Ingest शेड्यूल | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint शेड्यूल | महीने की 1 तारीख 8:00 | महीने की 2 तारीख 8:00 |
| शेड्यूलर | LaunchAgent | LaunchAgent |

> यदि आप एक ही मशीन पर चला रहे हैं, तो आप इस सेक्शन को पूरी तरह से अनदेखा कर सकते हैं। त्वरित प्रारंभ के चरण ही पर्याप्त हैं।

<br>

## रोडमैप

### निकट भविष्य
- [ ] **Ingest गुणवत्ता ट्यूनिंग** — 2 सप्ताह की वास्तविक Ingest रन के बाद Vault CLAUDE.md में चयन मानदंडों की समीक्षा और समायोजन
- [ ] **qmd बहुभाषी खोज** — गैर-अंग्रेजी सामग्री के लिए सिमैंटिक सर्च सटीकता सत्यापित करें; आवश्यकता पड़ने पर एम्बेडिंग मॉडल बदलें (उदा., `multilingual-e5-small`)
- [ ] **सुरक्षित ऑटो-फिक्स स्किल (`/wiki-fix-safe`)** — मानव अनुमोदन के साथ तुच्छ Lint समस्याओं (लापता क्रॉस-लिंक जोड़ना, फ्रंटमैटर गैप भरना) को ऑटो-फिक्स करें
- [ ] **Git सिंक त्रुटि दृश्यता** — `git push` विफलताओं को `session-logs/.kioku/git-sync.log` में लॉग करें और auto-ingest में चेतावनी दिखाएं

### मध्यम अवधि
- [ ] **मल्टी-LLM समर्थन** — auto-ingest/lint में `claude -p` को प्लगेबल LLM बैकएंड से बदलें (OpenAI API, Ollama के माध्यम से लोकल मॉडल, आदि)
- [ ] **CI/CD** — पुश पर स्वचालित परीक्षण के लिए GitHub Actions
- [ ] **Lint डिफ नोटिफिकेशन** — पिछली lint रिपोर्ट से तुलना करके केवल *नई पहचानी गई* समस्याएं दिखाएं
- [ ] **index.json के लिए ऑप्टिमिस्टिक लॉकिंग** — कई Claude Code सेशन समानांतर चलने पर खोए हुए अपडेट को रोकें

### दीर्घकालिक
- [ ] **मॉर्निंग ब्रीफिंग** — दैनिक सारांश स्वचालित रूप से उत्पन्न करें (कल के सेशन, खुले निर्णय, नई जानकारी) `wiki/daily/YYYY-MM-DD.md` के रूप में
- [ ] **प्रोजेक्ट-अवेयर कॉन्टेक्स्ट इंजेक्शन** — वर्तमान प्रोजेक्ट (`cwd` पर आधारित) के अनुसार `wiki/index.md` को फ़िल्टर करें ताकि 10,000-कैरेक्टर सीमा में रहें
- [ ] **स्टैक रिकमेंडेशन स्किल (`/wiki-suggest-stack`)** — संचित Wiki ज्ञान के आधार पर नए प्रोजेक्ट के लिए टेक स्टैक सुझाएं
- [ ] **टीम Wiki** — बहु-व्यक्ति Wiki साझाकरण (प्रत्येक सदस्य के session-logs लोकल रहते हैं; केवल wiki/ Git के माध्यम से साझा होता है)

> **नोट**: KIOKU को वर्तमान में **Claude Code (Max plan)** की आवश्यकता है। Hook सिस्टम (L0) और Wiki कॉन्टेक्स्ट इंजेक्शन Claude Code-विशिष्ट हैं। Ingest/Lint पाइपलाइन (L1/L2) `claude -p` कॉल को बदलकर अन्य LLM API के साथ काम कर सकती है — यह भविष्य के संवर्धन के रूप में योजनाबद्ध है।

<br>

## लाइसेंस

यह प्रोजेक्ट MIT License के अंतर्गत लाइसेंस प्राप्त है। विवरण के लिए [LICENSE](LICENSE) देखें।

जैसा कि ऊपर "महत्वपूर्ण नोट्स" अनुभाग में बताया गया है, यह सॉफ़्टवेयर बिना किसी प्रकार की वारंटी के "जैसा है" प्रदान किया गया है।

<br>

## संदर्भ

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — मूल अवधारणा जिसे यह प्रोजेक्ट लागू करता है
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — आधिकारिक Hook सिस्टम दस्तावेज़ीकरण
- [Obsidian](https://obsidian.md/) — Wiki व्यूअर के रूप में उपयोग किया जाने वाला ज्ञान प्रबंधन ऐप
- [qmd](https://github.com/tobi/qmd) — Markdown के लिए लोकल सर्च इंजन (BM25 + वेक्टर सर्च)


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## लेखक

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

कोड और AI से चीज़ें बनाता हूँ। फ्रीलांस इंजीनियर, 10 साल का अनुभव। फ्रंटएंड पर फोकस, हाल ही में Claude के साथ को-डेवलपमेंट मेरा मुख्य वर्कफ़्लो है।

[फ़ॉलो करें](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
