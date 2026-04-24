## Este manual está disponible en varios idiomas

> [!NOTE]
> **🌐 Otros idiomas:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · 🇪🇸 **Español** · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code olvida el conocimiento adquirido en sesiones anteriores.
claude-brain **acumula automáticamente tus conversaciones en una Wiki** y **las recupera en la siguiente sesión**.

Ya no necesitas repetir las mismas explicaciones una y otra vez. Un 'second brain' que crece con cada uso — para tu Claude.

<br>

### Notas importantes

> [!CAUTION]
> claude-brain actualmente requiere **Claude Code (plan Max)**. El sistema de Hooks (L0) y la inyeccion de contexto del Wiki son funcionalidades especificas de Claude Code. El pipeline de Ingest/Lint (L1/L2) puede funcionar con otras APIs de LLM sustituyendo la llamada a `claude -p` — esto esta planificado como una mejora futura.

> [!WARNING]
> **Entiende antes de instalar:** claude-brain se conecta a **toda la E/S de las sesiones de Claude Code**. Esto significa:
> - Los registros de sesión pueden contener **claves API, tokens o información personal** de tus prompts y la salida de herramientas. El enmascaramiento cubre los patrones principales pero no es exhaustivo — consulta [SECURITY.md](SECURITY.md)
> - Si `.gitignore` está mal configurado, los registros de sesión podrían ser **enviados accidentalmente a GitHub**
> - El pipeline de auto-ingest envía el contenido de los registros de sesión a Claude a través de `claude -p` para la extracción al Wiki
>
> Recomendamos comenzar con `KIOKU_DRY_RUN=1` para verificar el pipeline antes de habilitar la operación completa.

> [!IMPORTANT]
> Este software se proporciona **"tal cual"**, sin garantia de ningun tipo. Los autores no asumen **ninguna responsabilidad** por cualquier perdida de datos, incidentes de seguridad o danos derivados del uso de esta herramienta. Uselo bajo su propio riesgo. Consulte [LICENSE](../../LICENSE) para los terminos completos.

<br>

## Qué hace

```
🗣️  Conversa con Claude Code como siempre
         ↓  （todo se registra automáticamente — no necesitas hacer nada）
📝  Los registros de sesión se guardan localmente
         ↓  （una tarea programada le pide a la IA leer los registros y extraer conocimiento）
📚  La Wiki crece con cada sesión — conceptos, decisiones, patrones
         ↓  （sincronizado via Git）
☁️  GitHub mantiene tu Wiki respaldada y compartida entre máquinas
```

1. **Captura automática (L0)**: Captura eventos de hooks de Claude Code (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) y escribe Markdown en `session-logs/`
2. **Estructuración (L1)**: La ejecución programada (macOS LaunchAgent / Linux cron) hace que el LLM lea los logs no procesados y construya páginas de conceptos, páginas de proyectos y decisiones de diseño en `wiki/`. Los análisis de sesiones también se guardan en `wiki/analyses/`
3. **Verificación de integridad (L2)**: La comprobación mensual de salud del wiki genera `wiki/lint-report.md`. Incluye detección automática de fugas de secretos
4. **Sincronización (L3)**: El Vault en sí es un repositorio Git. `SessionStart` ejecuta `git pull`, `SessionEnd` ejecuta `git commit && git push`, sincronizando entre máquinas a través de un repositorio privado en GitHub
5. **Inyección de contexto del wiki**: En `SessionStart`, `wiki/index.md` se inyecta en el prompt del sistema para que Claude pueda aprovechar el conocimiento previo
6. **Búsqueda de texto completo qmd**: Busca en el wiki a través de MCP con BM25 + búsqueda semántica
7. **Skills de Wiki Ingest**: Los comandos slash `/wiki-ingest-all` y `/wiki-ingest` importan conocimiento existente del proyecto al Wiki
8. **Aislamiento de secretos**: `session-logs/` permanece local en cada máquina (`.gitignore`). Solo `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` se gestionan con Git

<br>

## Requisitos previos

| | Versión / Requisito |
|---|---|
| macOS | 13+ recomendado |
| Node.js | 18+ (los scripts de hooks son `.mjs` ES Modules, sin dependencias externas) |
| Bash | 3.2+ (predeterminado en macOS) |
| Git | 2.x+. Debe soportar `git pull --rebase` / `git push` |
| GitHub CLI | Opcional (`gh` simplifica la creación de repos privados) |
| Claude Code | Versión con soporte del sistema de Hooks (`~/.claude/settings.json`) |
| Obsidian | Un Vault creado en cualquier carpeta (no se requiere iCloud Drive) |
| jq | 1.6+ (usado por `install-hooks.sh --apply`) |
| Variable de entorno | `OBSIDIAN_VAULT` apuntando a la raíz del Vault |

<br>

## Inicio rápido

### 1. Crear un Vault y conectarlo a un repositorio Git (manual)

1. Crea un nuevo Vault en Obsidian (por ejemplo, `~/claude-brain/main-claude-brain`)
2. Crea un repositorio privado en GitHub (por ejemplo, `claude-brain`)
3. En el directorio del Vault: `git init && git remote add origin ...` (o `gh repo create --private --source=. --push`)

Este paso no está automatizado por los scripts de claude-brain. La autenticación con GitHub (gh CLI / claves SSH) depende de tu entorno.

### 2. Configurar la variable de entorno

```bash
# Añadir a ~/.zshrc o ~/.bashrc
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

### 3. Inicializar el Vault

```bash
# Crea raw-sources/, session-logs/, wiki/, templates/ dentro del Vault,
# coloca CLAUDE.md / .gitignore / plantillas iniciales (nunca sobrescribe archivos existentes)
bash tools/claude-brain/scripts/setup-vault.sh
```

### 4. Instalar los Hooks

```bash
# Opción A: Fusión automática (recomendado, requiere jq)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# Crea respaldo → muestra diff → solicita confirmación → añade entradas de hooks preservando la configuración existente

# Opción B: Fusión manual
bash tools/claude-brain/scripts/install-hooks.sh
# Muestra el fragmento JSON en stdout para fusionar manualmente en ~/.claude/settings.json
```

### 5. Verificar

Reinicia Claude Code y mantén una conversación.
Debería aparecer `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md`.

### 6. Configurar la ejecución programada (recomendado)

Configura Ingest automático (diario) y Lint (mensual).

```bash
# Detecta automáticamente el SO: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# Prueba primero con DRY RUN
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **Nota para macOS**: Colocar el repositorio en `~/Documents/` o `~/Desktop/` puede hacer que TCC (Transparency, Consent, Control) bloquee el acceso en segundo plano con EPERM. Usa una ruta fuera de los directorios protegidos (por ejemplo, `~/_PROJECT/`).

### 7. Configurar el motor de búsqueda qmd (opcional)

Habilita la búsqueda de texto completo y semántica del Wiki mediante MCP.

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

### 8. Instalar los skills de Wiki Ingest (opcional)

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

### 9. Desplegar en máquinas adicionales

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Abre ~/claude-brain/main-claude-brain/ como Vault en Obsidian
# Repite los pasos 2–6
```

<br>

## Estructura de directorios

```
tools/claude-brain/
├── README.md                        ← Este archivo
├── context/                         ← Implementación actual (INDEX + documentos por funcionalidad)
├── handoff/                         ← Notas de traspaso para la próxima sesión
├── plan/
│   ├── user/                      ← Instrucciones de diseño del usuario
│   └── claude/                      ← Especificaciones de implementación de Claude
├── hooks/
│   ├── session-logger.mjs           ← Punto de entrada del Hook (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: inyecta wiki/index.md en el prompt del sistema
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Comando slash para importación masiva de proyecto al Wiki
│   └── wiki-ingest/SKILL.md         ← Comando slash para escaneo dirigido
├── templates/
│   ├── vault/                       ← Archivos raíz del Vault (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Plantillas de notas (concept, project, decision, source-summary)
│   ├── wiki/                        ← Archivos iniciales del wiki (index.md, log.md)
│   └── launchd/*.plist.template     ← Plantillas de macOS LaunchAgent
├── scripts/
│   ├── setup-vault.sh               ← Inicialización del Vault (idempotente)
│   ├── install-hooks.sh             ← Salida del fragmento de configuración del Hook / --apply para fusión automática
│   ├── auto-ingest.sh               ← Programado: ingesta de logs no procesados al wiki
│   ├── auto-lint.sh                 ← Programado: informe de salud del wiki + escaneo de secretos
│   ├── install-cron.sh              ← Muestra entradas de cron en stdout
│   ├── install-schedule.sh          ← Despachador según SO (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← Instalador de macOS LaunchAgent
│   ├── setup-qmd.sh                 ← Registro de colección qmd + indexación inicial
│   ├── install-qmd-daemon.sh        ← Servidor HTTP MCP de qmd como daemon de launchd
│   ├── install-skills.sh            ← Enlace simbólico de skills wiki-ingest a ~/.claude/skills/
│   └── scan-secrets.sh              ← Detección de fugas de secretos en session-logs/
└── tests/                           ← node --test y pruebas de humo en bash
```

<br>

## Variables de entorno

| Variable | Valor predeterminado | Propósito |
|---|---|---|
| `OBSIDIAN_VAULT` | ninguno (requerido) | Raíz del Vault. auto-ingest/lint recurren a `${HOME}/claude-brain/main-claude-brain` como alternativa |
| `KIOKU_DRY_RUN` | `0` | `1` para omitir llamadas a `claude -p` (solo verificación de rutas) |
| `KIOKU_NO_LOG` | no definido | `1` para suprimir session-logger.mjs (previene el registro recursivo desde subprocesos de cron) |
| `KIOKU_DEBUG` | no definido | `1` para emitir información de depuración a stderr y `session-logs/.claude-brain/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ruta del log de Ingest (referenciado por el autodiagnóstico de auto-lint) |

### Configuración de PATH para gestores de versiones de Node

Los scripts programados (`auto-ingest.sh`, `auto-lint.sh`) se ejecutan desde cron / LaunchAgent y no heredan el PATH de tu shell interactiva. Añaden Volta (`~/.volta/bin`) y mise (`~/.local/share/mise/shims`) al PATH. **Si usas nvm / fnm / asdf u otro gestor de versiones**, edita la línea `export PATH=...` en la parte superior de cada script:

```bash
# ejemplo con nvm
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# ejemplo con fnm
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Notas de diseño

- **Los logs de sesión contienen secretos**: Los prompts y la salida de herramientas pueden incluir claves API, tokens o información personal. `session-logger.mjs` aplica enmascaramiento con expresiones regulares antes de escribir
- **Límite de escritura**: Los Hooks solo escriben en `$OBSIDIAN_VAULT/session-logs/`. Nunca tocan `raw-sources/`, `wiki/` ni `templates/`
- **session-logs nunca llega a Git**: Excluido por `.gitignore`, minimizando el riesgo de envíos accidentales a GitHub
- **Sin acceso a la red**: Los scripts de hooks (`session-logger.mjs`) no importan `http`/`https`/`net`/`dgram`. La sincronización Git se maneja con comandos shell de una línea en la configuración del Hook
- **Idempotente**: `setup-vault.sh` / `install-hooks.sh` pueden ejecutarse múltiples veces sin destruir archivos existentes
- **Sin git init**: `setup-vault.sh` no inicializa un repositorio Git ni añade remotos. La autenticación con GitHub es responsabilidad del usuario

<br>

## Seguridad

claude-brain es un sistema de Hooks que accede a **toda la E/S de las sesiones de Claude Code**.
Consulta [SECURITY.md](SECURITY.md) para el diseño de seguridad completo.

### Capas de defensa

| Capa | Descripción |
|---|---|
| **Validación de entrada** | La ruta de `OBSIDIAN_VAULT` se verifica en busca de metacaracteres de shell y caracteres de control JSON/XML |
| **Enmascaramiento** | Claves API (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), autenticación Bearer/Basic, credenciales en URL, claves privadas PEM se reemplazan con `***` |
| **Permisos** | `session-logs/` se crea con `0o700`, archivos de log con `0o600`. Los scripts de hooks se configuran con `chmod 755` |
| **Protección .gitignore** | Verifica que `.gitignore` contenga `session-logs/` antes de cada git commit |
| **Prevención de recursión** | `KIOKU_NO_LOG=1` + verificación de cwd-in-vault (doble protección) previene el registro recursivo desde subprocesos |
| **Restricción de permisos del LLM** | auto-ingest / auto-lint ejecutan `claude -p` con `--allowedTools Write,Read,Edit` (sin Bash) |
| **Escaneo periódico** | `scan-secrets.sh` escanea session-logs/ mensualmente en busca de patrones de tokens conocidos para detectar fallos de enmascaramiento |

### Añadir patrones de tokens

Cuando empieces a usar un nuevo servicio en la nube, añade su patrón de token tanto a `hooks/session-logger.mjs` (`MASK_RULES`) como a `scripts/scan-secrets.sh` (`PATTERNS`).

### Reportar vulnerabilidades

Si encuentras un problema de seguridad, repórtalo a través de [SECURITY.md](SECURITY.md) — no mediante Issues públicos.

<br>

## Cambios

### 2026-04-24 — v0.6.0: Expansion del ecosistema — multi-agente + marketplace de plugins + dashboard Bases + delta tracking + endurecimiento de seguridad

v0.6.0 consolida Phase C: canales de distribucion, dashboards nativos de Obsidian, ingest resistente a regresiones, y actualizacion de politica de seguridad.

- **Multi-agente cross-platform (C-1)** — `scripts/setup-multi-agent.sh` crea symlinks en Codex / OpenCode / Gemini CLI. 19/19 aserciones Bash
- **Marketplace Claude Code (C-2)** — `claude marketplace add megaphone-tokyo/kioku && claude plugin install kioku@megaphone-tokyo`
- **Delta tracking sha256 (C-3)** — Archivos MD colocados en `raw-sources/<subdir>/*.md` ahora participan en la deteccion delta. 82/82 aserciones auto-ingest
- **Dashboard Obsidian Bases (C-4)** — `templates/wiki/meta/dashboard.base` con 9 vistas
- **Cimientos Visualizer (V-1, v0.7)** — `mcp/lib/git-history.mjs` + `mcp/lib/wiki-snapshot.mjs`, 14/14 aserciones Node
- **Politica de seguridad (C-5a)** — CVE Classification / Safe Harbor / Coordinated Disclosure Timeline. `SECURITY.ja.md` 4/7 secciones
- **Canal comunitario** — Discord dedicado descartado, GitHub Discussions canonico
- **LEARN organizacional** — LEARN#10 (script verify en handoff PM)
- **Diferido v0.7+** — UI HTML Visualizer, LP β, GitHub Discussions, 3 secciones SECURITY.ja restantes
- Tests: **Node 264/264 + Bash 400+/400+ verdes**
- [Release v0.6.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.6.0) — `kioku-wiki-0.6.0.mcpb` (~9 MB)

### 2026-04-23 — v0.5.1: Hot cache + hook PostCompact + prompt Stop opt-in

- **Patron hot cache** — Nuevo `wiki/hot.md` (<=500 palabras, limite rigido 4000 caracteres) se inyecta automaticamente en **SessionStart** y se reinyecta tras **PostCompact** (compactacion de contexto), para que el LLM conserve el contexto de trabajo a corto plazo entre sesiones y compactaciones. Inspirado en el patron UX de claude-obsidian
- **Hook PostCompact** — `install-hooks.sh` ahora cablea un 6.o evento (`PostCompact`) que reinyecta solo hot.md (index.md ya esta en el contexto tras la compactacion, asi que se omite para evitar inflado de tokens)
- **Prompt Stop opt-in** (`KIOKU_HOT_AUTO_PROMPT=1`) — Cuando se establece explicitamente, el final de sesion dispara una sugerencia de actualizacion para hot.md. **Por defecto OFF** — hot.md esta sincronizado por Git y tiene un limite de seguridad mas estricto que session-logs, por lo que el prompt automatico requiere consentimiento explicito del usuario
- **Limite de seguridad mantenido** — hot.md pasa por `applyMasks()` (enmascarado de API key / token) antes de la inyeccion, esta en el objetivo del walk de scan-secrets.sh, rechaza symlink escape via `realpath` (rutas externas al vault rechazadas) y trunca en 4000 caracteres con log WARN
- **Alineacion con schema de hook de Claude Code v2 (4 hotfixes)** — Claude Code v2 usa distintos schemas de salida por evento: `hookSpecificOutput` solo se admite para `PreToolUse` / `UserPromptSubmit` / `PostToolUse`; `PostCompact` y `Stop` deben usar `systemMessage` de nivel superior. El antiguo v1 flat `{additionalContext}` se descarta silenciosamente en v2. Los hotfixes 1-4 migran toda la salida de hooks al schema correcto por evento
- Tests: **47 aserciones Node** (HOT-1..9d + HOT-V1/V2 + regresion session-logger + H1-H5 injector) **+ 488 aserciones Bash** (IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 15 suites existentes), todo verde
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` adjunto (9.2 MB)

### 2026-04-23 — v0.5.0: funcionalidad 2.4 — router unificado de ingest para PDF / MD / EPUB / DOCX

- **Fase 1** — Router `kioku_ingest_document`: una herramienta MCP unificada que despacha por extensión de archivo (`.pdf` / `.md` / `.epub` / `.docx`) al handler correspondiente. El `kioku_ingest_pdf` existente pasa a ser un alias de deprecación que se mantendrá durante la ventana v0.5 – v0.7; su eliminación está planificada para v0.8
- **Fase 2** — Ingesta de EPUB: extracción segura mediante yauzl con defensa en 8 capas (zip-slip / symlink / límite de tamaño acumulado / límite de conteo de entradas / nombres de archivo NFKC / skip de ZIP anidados / pre-scan XXE / sanitización de scripts en XHTML). Los capítulos en orden de spine se convierten a chunks Markdown (`readability-extract` + `turndown`), guardados en `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`; los EPUB multicapítulo también obtienen un `-index.md`. Los resúmenes del LLM fluyen de forma asíncrona por el cron de auto-ingest
- **Fase 3** — Ingesta de DOCX (MVP): arquitectura en dos capas `mammoth + yauzl` (la superficie de ataque interna de jszip en mammoth queda pre-protegida por la defensa en 8 capas de yauzl). `word/document.xml` / `docProps/core.xml` pasan por un pre-scan XXE (`assertNoDoctype`). Las imágenes (VULN-D004/D007) y el contenido OLE embebido (VULN-D006) quedan diferidos — el MVP extrae únicamente texto del cuerpo + encabezados. Los metadatos se encierran en una valla `--- DOCX METADATA ---` con la anotación **untrusted** para delimitar la inyección de prompts en el resumen posterior del LLM
- **Hotfix pre-release** — Corregido el regex de argv en `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` para que sea Unicode-aware (`\p{L}\p{N}`); el `\w` anterior (solo ASCII) saltaba silenciosamente nombres de archivo en japonés / chino como `論文.docx` / `日本語.epub` en la ruta del cron de auto-ingest. EPUB estaba en esta regresión latente desde v0.4.0 y queda arreglado retroactivamente (LEARN#6 cross-boundary drift). Adicionalmente, `meta` / `base` / `link` fueron añadidos a los `DANGEROUS_TAGS` de `html-sanitize` como defensa en profundidad para futuras rutas de consumidores de EPUB
- **Problema conocido (no aplicable)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium) afecta a la API **XMLBuilder** (escritor de XML). Este código base utiliza únicamente **XMLParser** (lector de XML) en `mcp/lib/xml-safe.mjs`, por lo que la vulnerabilidad no es explotable. La dependencia se actualizará a `fast-xml-parser@^5.7.0` en **v0.5.1** para silenciar la alerta de dependabot
- Tests: **158 aserciones Bash + suite Node completa en verde** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / capa MCP 30). `npm audit` reporta **0 vulnerabilidades** en dependencias runtime; los informes `/security-review` paralelos red-hacker + blue-hacker reportan **0 hallazgos HIGH/CRITICAL**
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` adjunto (9.2 MB)

### 2026-04-21 — v0.4.0: revisión de Tier A (seguridad + operaciones) + Tier B (limpieza)

- **A#1** — Actualización de `@mozilla/readability` 0.5 → 0.6 (ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7) mitigado; 144 dependencias de producción pasan `npm audit` sin alertas)
- **A#2** — Añadida la guarda `git symbolic-ref -q HEAD` en `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd, evitando commits descontrolados cuando el Vault está en estado detached-HEAD (observada una deriva de 5 días en una máquina antes del fix)
- **A#3** — Refactorizado `withLock` (tiempo de bloqueo reducido de minutos a segundos), eliminada por completo la API `skipLock` y añadida la limpieza de PDFs huérfanos
- **B#1** — Re-auditoría de la capa Hook (`session-logger.mjs`): corregidos 3 hallazgos MEDIUM (bypass del masking por caracteres invisibles, YAML injection en el frontmatter, deriva de strict-equality en `KIOKU_NO_LOG`)
- **B#2** — Formalizada la paridad de guardas cron/setup como `tests/cron-guard-parity.test.sh` (17 aserciones) para hacer cumplir las convenciones de override de env Categoría-A / Categoría-B
- **B#3** — Evitada la condición de carrera entre máquinas en `sync-to-app.sh` mediante `check_github_side_lock` (guarda α, ventana predeterminada de 120s, configurable con `KIOKU_SYNC_LOCK_MAX_AGE`); regresión asegurada por `tests/sync-to-app.test.sh` (11 aserciones)
- **B#8** — Paridad i18n del README: secciones §10 MCP / §11 MCPB / Cambios añadidas a los 8 READMEs que no son en/ja (+1384 líneas)
- Tests: **299 Node tests** + **15 Bash suites / 415 aserciones**, todos en verde
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` adjunto

### 2026-04-17 — Fase N: paquete MCPB para Claude Desktop
- Nuevo `mcp/manifest.json` (MCPB v0.4) y `scripts/build-mcpb.sh` generan `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 MB)
- Los usuarios de Claude Desktop pueden instalar el servidor MCP arrastrando un solo archivo. `OBSIDIAN_VAULT` se configura mediante el selector de directorio en el diálogo de instalación (no requiere Node en la máquina del usuario — Desktop usa su runtime incorporado)
- Para instrucciones detalladas consulta [README.md](README.md) o [README.ja.md](README.ja.md)

### 2026-04-17 — Fase M: servidor MCP kioku-wiki
- Servidor MCP local stdio (`tools/claude-brain/mcp/`) que expone seis herramientas — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Tanto Claude Desktop como Claude Code pueden ahora navegar, buscar y actualizar el Wiki sin salir del chat
- Para instrucciones de configuración consulta [README.md](README.md) o [README.ja.md](README.ja.md)

### 2026-04-16 — Fase L: migración a macOS LaunchAgent
- El nuevo despachador `scripts/install-schedule.sh` selecciona LaunchAgent (macOS) o cron (Linux) automáticamente

<br>

## Referencias

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — El concepto original que este proyecto implementa
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Documentacion oficial del sistema de Hooks
- [Obsidian](https://obsidian.md/) — La aplicacion de gestion del conocimiento utilizada como visor del Wiki
- [qmd](https://github.com/tobi/qmd) — Motor de busqueda local para Markdown (BM25 + busqueda vectorial)

## Autor

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Construyendo cosas con codigo e IA. Ingeniero freelance con 10 anos de experiencia. Enfocado en frontend, ultimamente co-desarrollando con Claude como mi flujo de trabajo principal.

[Sígueme en X](https://x.com/megaphone_tokyo)
