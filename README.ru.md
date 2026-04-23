## Это руководство доступно на нескольких языках

> [!NOTE]
> **🌐 Другие языки:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · 🇷🇺 **Русский**

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code забывает знания, полученные в прошлых сессиях.
claude-brain **автоматически накапливает ваши разговоры в Wiki** и **восстанавливает их в следующей сессии**.

Больше не нужно повторять одни и те же объяснения снова и снова. «Second brain», который растёт с каждым использованием — для вашего Claude.

<br>

## Важные замечания

> [!CAUTION]
> claude-brain в настоящее время требует **Claude Code (план Max)**. Система хуков (L0) и внедрение контекста Wiki являются функциями, специфичными для Claude Code. Пайплайн Ingest/Lint (L1/L2) может работать с другими LLM API путём замены вызова `claude -p` — это запланировано как будущее улучшение.

> [!IMPORTANT]
> Данное программное обеспечение предоставляется **«как есть»**, без каких-либо гарантий. Авторы **не несут ответственности** за любую потерю данных, инциденты безопасности или ущерб, возникший в результате использования этого инструмента. Используйте на свой страх и риск. Полные условия см. в [LICENSE](../../LICENSE).

<br>

## Что делает этот инструмент

Автоматическая запись сессий Claude Code и построение структурированной базы знаний в хранилище Obsidian Vault. Объединяет паттерн LLM Wiki Андрея Карпати с автоматическим логированием и синхронизацией через Git между несколькими машинами.

```
🗣️  Общайтесь с Claude Code как обычно
         ↓  （всё записывается автоматически — вам ничего не нужно делать）
📝  Логи сессий сохраняются локально
         ↓  （по расписанию ИИ читает логи и извлекает знания）
📚  Wiki растёт с каждой сессией — концепции, решения, паттерны
         ↓  （синхронизация через Git）
☁️  GitHub хранит вашу Wiki и делится ею между машинами
```

1. **Автозапись (L0)**: Перехватывает события хуков Claude Code (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) и записывает Markdown в `session-logs/`
2. **Структурирование (L1)**: По расписанию (macOS LaunchAgent / Linux cron) LLM читает необработанные логи и формирует страницы концепций, проектов и проектных решений в `wiki/`. Аналитика сессий также сохраняется в `wiki/analyses/`
3. **Проверка целостности (L2)**: Ежемесячная проверка здоровья wiki генерирует `wiki/lint-report.md`. Включает автоматическое обнаружение утечек секретов
4. **Синхронизация (L3)**: Сам Vault является Git-репозиторием. `SessionStart` выполняет `git pull`, `SessionEnd` выполняет `git commit && git push`, синхронизируя данные между машинами через приватный репозиторий на GitHub
5. **Внедрение контекста wiki**: При `SessionStart` содержимое `wiki/index.md` внедряется в системный промпт, чтобы Claude мог использовать накопленные знания
6. **Полнотекстовый поиск qmd**: Поиск по wiki через MCP с BM25 + семантический поиск
7. **Навыки Wiki Ingest**: Слеш-команды `/wiki-ingest-all` и `/wiki-ingest` импортируют существующие знания проекта в Wiki
8. **Изоляция секретов**: `session-logs/` остаётся локальным на каждой машине (`.gitignore`). Только `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` управляются через Git

<br>

## Предварительные требования

| | Версия / Требование |
|---|---|
| macOS | Рекомендуется 13+ |
| Node.js | 18+ (скрипты хуков — `.mjs` ES Modules, без внешних зависимостей) |
| Bash | 3.2+ (по умолчанию в macOS) |
| Git | 2.x+. Должен поддерживать `git pull --rebase` / `git push` |
| GitHub CLI | Опционально (`gh` упрощает создание приватного репозитория) |
| Claude Code | **Требуется план Max** (используется `claude` CLI и система хуков в `~/.claude/settings.json`) |
| Obsidian | Один Vault, созданный в любой папке (iCloud Drive не требуется) |
| jq | 1.6+ (используется `install-hooks.sh --apply`) |
| Переменная окружения | `OBSIDIAN_VAULT`, указывающая на корень Vault |

<br>

## Быстрый старт

> [!WARNING]
> **Разберитесь перед установкой:** claude-brain подключается ко **всему вводу-выводу сессий Claude Code**. Это означает:
> - Логи сессий могут содержать **API-ключи, токены или персональные данные** из ваших промптов и вывода инструментов. Маскирование покрывает основные паттерны, но не является исчерпывающим — см. [SECURITY.md](SECURITY.md)
> - Если `.gitignore` настроен неправильно, логи сессий могут быть **случайно отправлены на GitHub**
> - Пайплайн автоматического инжеста отправляет содержимое логов сессий в Claude через `claude -p` для извлечения данных в Wiki
>
> Рекомендуем начать с `KIOKU_DRY_RUN=1`, чтобы проверить пайплайн перед включением полноценной работы.

### 🚀 Интерактивная настройка (Рекомендуется)

> [!NOTE]
> Введите следующее в Claude Code, чтобы начать интерактивную настройку с пошаговым руководством. Она объясняет назначение каждого шага и адаптируется к вашему окружению.

```
Please read tools/claude-brain/skills/setup-guide/SKILL.md and guide me through the claude-brain installation.
```

### 🛠️ Ручная настройка

> [!NOTE]
> Для тех, кто хочет понять каждый шаг. Запускайте скрипты напрямую.

#### 1. Создайте Vault и подключите его к Git-репозиторию (вручную)

1. Создайте новый Vault в Obsidian (например, `~/claude-brain/main-claude-brain`)
2. Создайте приватный репозиторий на GitHub (например, `claude-brain`)
3. В директории Vault: `git init && git remote add origin ...` (или `gh repo create --private --source=. --push`)

Этот шаг не автоматизирован скриптами claude-brain. Аутентификация на GitHub (gh CLI / SSH-ключи) зависит от вашего окружения.

#### 2. Задайте переменную окружения

```bash
# Добавьте в ~/.zshrc или ~/.bashrc
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

#### 3. Инициализируйте Vault

```bash
# Создаёт raw-sources/, session-logs/, wiki/, templates/ внутри Vault,
# размещает CLAUDE.md / .gitignore / начальные шаблоны (никогда не перезаписывает существующие файлы)
bash tools/claude-brain/scripts/setup-vault.sh
```

#### 4. Установите хуки

```bash
# Вариант A: Автоматическое слияние (рекомендуется, требуется jq)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# Создаёт резервную копию → показывает diff → запрашивает подтверждение → добавляет записи хуков, сохраняя существующую конфигурацию

# Вариант B: Ручное слияние
bash tools/claude-brain/scripts/install-hooks.sh
# Выводит JSON-фрагмент в stdout для ручного добавления в ~/.claude/settings.json
```

#### 5. Проверьте работу

Перезапустите Claude Code, затем проведите один разговор.
Должен появиться файл `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md`.

> **Шаги 1-5 обязательны.** Следующие шаги опциональны, но рекомендуются для полной функциональности.

#### 6. Настройте выполнение по расписанию (рекомендуется)

Настройте автоматический Ingest (ежедневно) и Lint (ежемесячно).

```bash
# Автоматически определяет ОС: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# Сначала протестируйте в режиме DRY RUN
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **Примечание для macOS**: Размещение репозитория в `~/Documents/` или `~/Desktop/` может привести к тому, что TCC (Transparency, Consent, Control) заблокирует фоновый доступ с ошибкой EPERM. Используйте путь за пределами защищённых директорий (например, `~/_PROJECT/`).

#### 7. Настройте поисковый движок qmd (опционально)

Включите полнотекстовый и семантический поиск по Wiki через MCP.

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

#### 8. Установите навыки Wiki Ingest (опционально)

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

#### 9. Разверните на дополнительных машинах

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Откройте ~/claude-brain/main-claude-brain/ как Vault в Obsidian
# Повторите шаги 2–6
```

<br>

## Структура директорий

```
tools/claude-brain/
├── README.md                        ← Этот файл
├── context/                         ← Текущая реализация (INDEX + документация по функциям)
├── handoff/                         ← Заметки для передачи следующей сессии
├── plan/
│   ├── user/                      ← Проектные инструкции пользователя
│   └── claude/                      ← Спецификации реализации Claude
├── hooks/
│   ├── session-logger.mjs           ← Точка входа хука (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: внедрение wiki/index.md в системный промпт
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Слеш-команда массового импорта проекта в Wiki
│   └── wiki-ingest/SKILL.md         ← Слеш-команда целевого сканирования
├── templates/
│   ├── vault/                       ← Файлы корня Vault (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Шаблоны заметок (concept, project, decision, source-summary)
│   ├── wiki/                        ← Начальные файлы wiki (index.md, log.md)
│   └── launchd/*.plist.template     ← Шаблоны macOS LaunchAgent
├── scripts/
│   ├── setup-vault.sh               ← Инициализация Vault (идемпотентная)
│   ├── install-hooks.sh             ← Вывод конфигурации хуков / --apply для автослияния
│   ├── auto-ingest.sh               ← По расписанию: обработка необработанных логов в wiki
│   ├── auto-lint.sh                 ← По расписанию: отчёт о здоровье wiki + сканирование секретов
│   ├── install-cron.sh              ← Вывод записей cron в stdout
│   ├── install-schedule.sh          ← Диспетчер с определением ОС (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← Установщик macOS LaunchAgent
│   ├── setup-qmd.sh                 ← Регистрация коллекции qmd + первоначальная индексация
│   ├── install-qmd-daemon.sh        ← HTTP-сервер qmd MCP как демон launchd
│   ├── install-skills.sh            ← Создание символических ссылок навыков wiki-ingest в ~/.claude/skills/
│   └── scan-secrets.sh              ← Обнаружение утечек секретов в session-logs/
└── tests/                           ← Тесты node --test и bash smoke tests
```

<br>

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OBSIDIAN_VAULT` | нет (обязательна) | Корень Vault. auto-ingest/lint используют запасной путь `${HOME}/claude-brain/main-claude-brain` |
| `KIOKU_DRY_RUN` | `0` | `1` для пропуска вызовов `claude -p` (только проверка путей) |
| `KIOKU_NO_LOG` | не задана | `1` для подавления session-logger.mjs (предотвращает рекурсивное логирование из cron-подпроцессов) |
| `KIOKU_DEBUG` | не задана | `1` для вывода отладочной информации в stderr и `session-logs/.claude-brain/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Путь вывода лога Ingest (используется самодиагностикой auto-lint) |

### Настройка PATH для менеджеров версий Node

Скрипты по расписанию (`auto-ingest.sh`, `auto-lint.sh`) запускаются из cron / LaunchAgent и не наследуют PATH вашей интерактивной оболочки. Они добавляют Volta (`~/.volta/bin`) и mise (`~/.local/share/mise/shims`) в PATH. **Если вы используете nvm / fnm / asdf или другой менеджер версий**, отредактируйте строку `export PATH=...` в начале каждого скрипта:

```bash
# Пример для nvm
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# Пример для fnm
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Замечания по архитектуре

- **Логи сессий содержат секреты**: Промпты и вывод инструментов могут содержать API-ключи, токены или персональные данные. `session-logger.mjs` применяет маскирование регулярными выражениями перед записью
- **Границы записи**: Хуки пишут только в `$OBSIDIAN_VAULT/session-logs/`. Они никогда не затрагивают `raw-sources/`, `wiki/` или `templates/`
- **session-logs никогда не попадают в Git**: Исключены через `.gitignore`, что минимизирует риск случайного пуша на GitHub
- **Нет сетевого доступа**: Скрипты хуков (`session-logger.mjs`) не импортируют `http`/`https`/`net`/`dgram`. Синхронизация через Git обеспечивается shell-однострочниками в конфигурации хуков
- **Идемпотентность**: `setup-vault.sh` / `install-hooks.sh` можно запускать многократно без уничтожения существующих файлов
- **Без git init**: `setup-vault.sh` не инициализирует Git-репозиторий и не добавляет remote. Аутентификация на GitHub — ответственность пользователя

<br>

## Безопасность

claude-brain — это система хуков, которая имеет доступ ко **всему вводу-выводу сессий Claude Code**.
Полное описание архитектуры безопасности см. в [SECURITY.md](SECURITY.md).

### Уровни защиты

| Уровень | Описание |
|---|---|
| **Валидация входных данных** | Путь `OBSIDIAN_VAULT` проверяется на наличие метасимволов оболочки и управляющих символов JSON/XML |
| **Маскирование** | API-ключи (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), токены Bearer/Basic авторизации, учётные данные в URL, приватные ключи PEM заменяются на `***` |
| **Права доступа** | `session-logs/` создаётся с правами `0o700`, файлы логов — `0o600`. Скрипты хуков устанавливаются с `chmod 755` |
| **Защита .gitignore** | Перед каждым git commit проверяется, что `.gitignore` содержит `session-logs/` |
| **Предотвращение рекурсии** | `KIOKU_NO_LOG=1` + проверка cwd-in-vault (двойная защита) предотвращает рекурсивное логирование из подпроцессов |
| **Ограничение прав LLM** | auto-ingest / auto-lint запускают `claude -p` с `--allowedTools Write,Read,Edit` (без Bash) |
| **Периодическое сканирование** | `scan-secrets.sh` ежемесячно сканирует session-logs/ на известные паттерны токенов для обнаружения сбоев маскирования |

### Добавление паттернов токенов

При подключении нового облачного сервиса добавьте его паттерн токена в оба файла: `hooks/session-logger.mjs` (`MASK_RULES`) и `scripts/scan-secrets.sh` (`PATTERNS`).

### Сообщение об уязвимостях

Если вы обнаружили проблему безопасности, пожалуйста, сообщите о ней через [SECURITY.md](SECURITY.md) — не через публичные Issues.

<br>

## Настройка для нескольких машин

claude-brain спроектирован для **совместного использования одной Wiki на нескольких машинах** через синхронизацию Git.
Автор использует конфигурацию с двумя Mac: MacBook (основная машина для разработки) и Mac mini (для режима bypass permission Claude Code).

Ключевые моменты для работы на нескольких машинах:
- **`session-logs/` остаётся локальным на каждой машине** (исключён через `.gitignore`). Логи сессий каждой машины независимы и никогда не пушатся в Git
- **`wiki/` синхронизируется через Git**. Результаты Ingest с любой машины накапливаются в одной Wiki
- **Разнесите время выполнения Ingest/Lint** между машинами, чтобы избежать конфликтов при git push
- Автоматический commit/push хука SessionEnd включён на всех машинах, но обычные сессии кодирования пишут только в `session-logs/` — операции git срабатывают только при прямом изменении `wiki/`

Справка: конфигурация автора с двумя Mac

| | MacBook (основной) | Mac mini (bypass) |
|---|---|---|
| Секреты | Да | Нет |
| `session-logs/` | Только локально | Только локально |
| `wiki/` | Синхронизация через Git | Синхронизация через Git |
| Расписание Ingest | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Расписание Lint | 1-е число месяца 8:00 | 2-е число месяца 8:00 |
| Планировщик | LaunchAgent | LaunchAgent |

> Если вы работаете на одной машине, можете полностью проигнорировать этот раздел. Шагов из Быстрого старта будет достаточно.

<br>

## Дорожная карта

### Ближайшие планы
- [ ] **Настройка качества Ingest** — Пересмотр и корректировка критериев отбора в Vault CLAUDE.md после 2 недель реальных запусков Ingest
- [ ] **Мультиязычный поиск qmd** — Проверка точности семантического поиска для неанглоязычного контента; замена модели эмбеддингов при необходимости (например, `multilingual-e5-small`)
- [ ] **Навык безопасного автоисправления (`/wiki-fix-safe`)** — Автоматическое исправление тривиальных проблем Lint с одобрением человека
- [ ] **Видимость ошибок синхронизации Git** — Логирование сбоев `git push` в `session-logs/.claude-brain/git-sync.log` и отображение предупреждений в auto-ingest

### Среднесрочные планы
- [ ] **Поддержка нескольких LLM** — Замена `claude -p` в auto-ingest/lint на подключаемый бэкенд LLM (OpenAI API, локальные модели через Ollama и т.д.)
- [ ] **CI/CD** — GitHub Actions для автоматического тестирования при пуше
- [ ] **Уведомления о diff Lint** — Показывать только *вновь обнаруженные* проблемы путём сравнения с предыдущим отчётом lint
- [ ] **Оптимистичная блокировка для index.json** — Предотвращение потери обновлений при параллельном запуске нескольких сессий Claude Code

### Долгосрочные планы
- [ ] **Утренний брифинг** — Автоматическая генерация ежедневного резюме как `wiki/daily/YYYY-MM-DD.md`
- [ ] **Внедрение контекста с учётом проекта** — Фильтрация `wiki/index.md` по текущему проекту для соблюдения лимита в 10 000 символов
- [ ] **Навык рекомендации стека (`/wiki-suggest-stack`)** — Предложение технологических стеков на основе накопленных знаний Wiki
- [ ] **Командная Wiki** — Совместное использование Wiki несколькими людьми (session-logs каждого участника остаются локальными; только wiki/ разделяется через Git)

> **Примечание**: claude-brain в настоящее время требует **Claude Code (план Max)**. Система хуков (L0) и внедрение контекста Wiki специфичны для Claude Code. Пайплайн Ingest/Lint (L1/L2) может работать с другими LLM API путём замены вызова `claude -p` — это запланировано как будущее улучшение.

<br>

## История изменений

### 2026-04-23 — v0.5.0: функция 2.4 — единый ingest-роутер для PDF / MD / EPUB / DOCX

- **Phase 1** — Роутер `kioku_ingest_document`: единый MCP-инструмент, диспетчеризующий по расширению файла (`.pdf` / `.md` / `.epub` / `.docx`) к соответствующему handler. Существующий `kioku_ingest_pdf` становится deprecation alias и сохраняется в окне v0.5 — v0.7; удаление запланировано на v0.8
- **Phase 2** — Загрузка EPUB: безопасное извлечение через yauzl с 8-слойной защитой (zip-slip / symlink / кумулятивный лимит размера / лимит количества entry / NFKC filename / skip вложенных ZIP / XXE pre-scan / sanitize script в XHTML). Главы в порядке spine конвертируются в Markdown-чанки (`readability-extract` + `turndown`) и сохраняются в `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`; для EPUB с несколькими главами дополнительно создаётся `-index.md`. LLM-резюме формируются асинхронно через cron auto-ingest
- **Phase 3** — Загрузка DOCX (MVP): двухслойная архитектура `mammoth + yauzl` (внутренняя поверхность атаки jszip у mammoth заблаговременно закрыта 8-слойной защитой yauzl). Файлы `word/document.xml` / `docProps/core.xml` проходят XXE pre-scan (`assertNoDoctype`). Изображения (VULN-D004/D007) и OLE-вложения (VULN-D006) отложены — MVP извлекает только основной текст + заголовки. Метаданные заключаются в fence `--- DOCX METADATA ---` с аннотацией **untrusted** для защиты от prompt injection в последующей LLM-суммаризации
- **Pre-release hotfix** — Исправлена argv-regex в `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` на Unicode-aware (`\p{L}\p{N}`); предыдущий `\w` (только ASCII) молча пропускал японские / китайские имена файлов типа `論文.docx` / `日本語.epub` на cron-пути auto-ingest. EPUB находился в этой латентной регрессии с v0.4.0 и исправлен ретроактивно (LEARN#6 cross-boundary drift). Дополнительно `meta` / `base` / `link` добавлены в `DANGEROUS_TAGS` модуля `html-sanitize` как defense-in-depth для будущих consumer-путей EPUB
- **Known issue (неприменимо)** — CVE-2026-41650 в `fast-xml-parser` ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium) затрагивает API **XMLBuilder** (XML writer). В этом кодовом базисе используется только **XMLParser** (XML reader) в `mcp/lib/xml-safe.mjs`, поэтому уязвимость неэксплуатируема. Зависимость будет обновлена до `fast-xml-parser@^5.7.0` в **v0.5.1** для закрытия alert от dependabot
- Тесты: **158 Bash assertion + полный Node suite зелёные** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / слой MCP 30). `npm audit` сообщает **0 уязвимостей** в runtime-зависимостях; параллельные `/security-review` red-hacker + blue-hacker сообщают **0 HIGH/CRITICAL** находок
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — приложен `kioku-wiki-0.5.0.mcpb` (9,2 МБ)

### 2026-04-21 — v0.4.0: комплексное обновление Tier A (безопасность + эксплуатация) + Tier B (чистота кода)

- **A#1** — Обновление `@mozilla/readability` 0.5 → 0.6 (устранена уязвимость ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7); 144 production-зависимости проходят `npm audit` без предупреждений)
- **A#2** — Добавлена защита `git symbolic-ref -q HEAD` в `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd, предотвращающая неконтролируемые коммиты, когда Vault находится в состоянии detached-HEAD (на одной из машин наблюдался дрейф 5 дней до внедрения фикса)
- **A#3** — Рефакторинг `withLock` (время удержания сокращено с минут до секунд), полностью удалён API `skipLock`, добавлена очистка orphan-PDF
- **B#1** — Повторный аудит слоя Hook (`session-logger.mjs`): исправлены 3 MEDIUM-находки (обход маскирования через invisible-символы, YAML injection во frontmatter, дрейф strict-equality у `KIOKU_NO_LOG`)
- **B#2** — Формализация паритета guard-ов cron/setup в виде `tests/cron-guard-parity.test.sh` (17 assertion), закрепляющего конвенции env-override Category-A / Category-B
- **B#3** — Устранена межмашинная гонка `sync-to-app.sh` через `check_github_side_lock` (α-guard, окно 120s по умолчанию, настраивается через `KIOKU_SYNC_LOCK_MAX_AGE`); регрессия зафиксирована в `tests/sync-to-app.test.sh` (11 assertion)
- **B#8** — Паритет i18n README: разделы §10 MCP / §11 MCPB / Changelog добавлены во все 8 README, отличных от en/ja (+1384 строк)
- Тесты: **299 Node-тестов** + **15 Bash-наборов / 415 assertion**, все зелёные
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` приложен

### 2026-04-17 — Фаза N: пакет MCPB для Claude Desktop
- Новый `mcp/manifest.json` (MCPB v0.4) и `scripts/build-mcpb.sh` генерируют `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 МБ)
- Пользователи Claude Desktop могут установить MCP-сервер перетаскиванием одного файла. `OBSIDIAN_VAULT` настраивается через выбор директории в диалоге установки (Node на машине пользователя не требуется — Desktop использует встроенную среду выполнения)
- Подробные инструкции см. в [README.md](README.md) или [README.ja.md](README.ja.md)

### 2026-04-17 — Фаза M: MCP-сервер kioku-wiki
- Локальный stdio MCP-сервер (`tools/claude-brain/mcp/`), предоставляющий шесть инструментов — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Теперь Claude Desktop и Claude Code могут просматривать, искать и обновлять Wiki, не покидая чат
- Инструкции по настройке см. в [README.md](README.md) или [README.ja.md](README.ja.md)

### 2026-04-16 — Фаза L: переход на macOS LaunchAgent
- Новый диспетчер `scripts/install-schedule.sh` автоматически выбирает LaunchAgent (macOS) или cron (Linux)

<br>

## Лицензия

Этот проект распространяется под лицензией MIT. Подробности см. в [LICENSE](../../LICENSE).

Как указано в разделе «Важные замечания» выше, данное программное обеспечение предоставляется «как есть» без каких-либо гарантий.

<br>

## Ссылки

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — Оригинальная концепция, которую реализует этот проект
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Официальная документация системы хуков
- [Obsidian](https://obsidian.md/) — Приложение для управления знаниями, используемое как просмотрщик Wiki
- [qmd](https://github.com/tobi/qmd) — Локальный поисковый движок для Markdown (BM25 + векторный поиск)

## Автор

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Создаю вещи с помощью кода и ИИ. Фрилансер-инженер, 10 лет опыта. Специализация — фронтенд, в последнее время основной рабочий процесс — совместная разработка с Claude.

[Подписаться](https://x.com/megaphone_tokyo)
