## Este manual está disponible en varios idiomas

> [!NOTE]
> **🌐 Otros idiomas:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · 🇪🇸 **Español** · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Max_Plan-orange)](https://claude.com/claude-code)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey)](#prerequisites)
[![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)

Claude Code olvida el conocimiento de sesiones anteriores.
KIOKU **acumula automaticamente tus conversaciones en una Wiki** y **las recupera en la siguiente sesion**.

No mas repetir las mismas explicaciones una y otra vez. Un "second brain" que crece con cada uso — para tu Claude.

<br>

## Que hace

Registra automaticamente las sesiones de Claude Code y construye una base de conocimiento estructurada en un Obsidian Vault.

Combina el patron LLM Wiki de Andrej Karpathy con la recoleccion automatica de logs y sincronizacion Git para compartir entre multiples maquinas.

```
🗣️  Conversa con Claude Code como siempre
         ↓  （todo se registra automaticamente — no necesitas hacer nada）
📝  Los registros de sesion se guardan localmente
         ↓  （una tarea programada le pide a la IA leer los registros y extraer conocimiento）
📚  La Wiki crece con cada sesion — conceptos, decisiones, patrones
         ↓  （sincronizado via Git）
☁️  GitHub mantiene tu Wiki respaldada y compartida entre maquinas
```

1. **Captura automatica (L0)**: Captura eventos de hooks de Claude Code (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) y escribe Markdown en `session-logs/`
2. **Estructuracion (L1)**: La ejecucion programada (macOS LaunchAgent / Linux cron) hace que el LLM lea los logs no procesados y construya paginas de conceptos, paginas de proyectos y decisiones de diseno en `wiki/`. Los analisis de sesiones tambien se guardan en `wiki/analyses/`
3. **Verificacion de integridad (L2)**: La comprobacion mensual de salud del wiki genera `wiki/lint-report.md`. Incluye deteccion automatica de fugas de secretos
4. **Sincronizacion (L3)**: El Vault en si es un repositorio Git. `SessionStart` ejecuta `git pull`, `SessionEnd` ejecuta `git commit && git push`, sincronizando entre maquinas a traves de un repositorio privado en GitHub
5. **Inyeccion de contexto del wiki**: En `SessionStart`, `wiki/index.md` se inyecta en el prompt del sistema para que Claude pueda aprovechar el conocimiento previo
6. **Busqueda de texto completo qmd**: Busca en el wiki a traves de MCP con BM25 + busqueda semantica
7. **Skills de Wiki Ingest**: Los comandos slash `/wiki-ingest-all` y `/wiki-ingest` importan conocimiento existente del proyecto al Wiki
8. **Aislamiento de secretos**: `session-logs/` permanece local en cada maquina (`.gitignore`). Solo `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` se gestionan con Git

<br>

## Notas importantes

> [!CAUTION]
> KIOKU actualmente requiere **Claude Code (plan Max)**. El sistema de Hooks (L0) y la inyeccion de contexto del Wiki son funcionalidades especificas de Claude Code. El pipeline de Ingest/Lint (L1/L2) puede funcionar con otras APIs de LLM sustituyendo la llamada a `claude -p` — esto esta planificado como una mejora futura.

> [!IMPORTANT]
> Este software se proporciona **"tal cual"**, sin garantia de ningun tipo. Los autores no asumen **ninguna responsabilidad** por cualquier perdida de datos, incidentes de seguridad o danos derivados del uso de esta herramienta. Uselo bajo su propio riesgo. Consulte [LICENSE](LICENSE) para los terminos completos.

<br>

## Requisitos previos

| | Version / Requisito |
|---|---|
| macOS | 13+ recomendado |
| Node.js | 18+ (los scripts de hooks son `.mjs` ES Modules, sin dependencias externas) |
| Bash | 3.2+ (predeterminado en macOS) |
| Git | 2.x+. Debe soportar `git pull --rebase` / `git push` |
| GitHub CLI | Opcional (`gh` simplifica la creacion de repos privados) |
| Claude Code | Version con soporte del sistema de Hooks (`~/.claude/settings.json`) |
| Obsidian | Un Vault creado en cualquier carpeta (no se requiere iCloud Drive) |
| jq | 1.6+ (usado por `install-hooks.sh --apply`) |
| Variable de entorno | `OBSIDIAN_VAULT` apuntando a la raiz del Vault |

<br>

## Inicio rapido

> [!WARNING]
> **Entiende antes de instalar:** KIOKU se conecta a **toda la E/S de las sesiones de Claude Code**. Esto significa:
> - Los registros de sesion pueden contener **claves API, tokens o informacion personal** de tus prompts y la salida de herramientas. El enmascaramiento cubre los patrones principales pero no es exhaustivo — consulta [SECURITY.md](SECURITY.md)
> - Si `.gitignore` esta mal configurado, los registros de sesion podrian ser **enviados accidentalmente a GitHub**
> - El pipeline de auto-ingest envia el contenido de los registros de sesion a Claude a traves de `claude -p` para la extraccion al Wiki
>
> Recomendamos comenzar con `KIOKU_DRY_RUN=1` para verificar el pipeline antes de habilitar la operacion completa.

### 🚀 Configuracion interactiva (Recomendada)

> [!NOTE]
> Introduce lo siguiente en Claude Code para iniciar una configuracion interactiva con guia paso a paso. Explica el proposito de cada paso y se adapta a tu entorno.

```
skills/setup-guide/SKILL.md を参照して、KIOKU のインストール作業をしてください。
```

### 🛠️ Configuracion manual

> [!NOTE]
> Para quienes quieran entender cada paso por si mismos. Ejecuta los scripts directamente.

#### 1. Crear un Vault y conectarlo a un repositorio Git (manual)

1. Crea un nuevo Vault en Obsidian (por ejemplo, `~/kioku/main-kioku`)
2. Crea un repositorio privado en GitHub (por ejemplo, `kioku`)
3. En el directorio del Vault: `git init && git remote add origin ...` (o `gh repo create --private --source=. --push`)

Este paso no esta automatizado por los scripts de KIOKU. La autenticacion con GitHub (gh CLI / claves SSH) depende de tu entorno.

#### 2. Configurar la variable de entorno

```bash
# Anadir a ~/.zshrc o ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Inicializar el Vault

```bash
# Crea raw-sources/, session-logs/, wiki/, templates/ dentro del Vault,
# coloca CLAUDE.md / .gitignore / plantillas iniciales (nunca sobrescribe archivos existentes)
bash scripts/setup-vault.sh
```

#### 4. Instalar los Hooks

```bash
# Opcion A: Fusion automatica (recomendado, requiere jq)
bash scripts/install-hooks.sh --apply
# Crea respaldo → muestra diff → solicita confirmacion → anade entradas de hooks preservando la configuracion existente

# Opcion B: Fusion manual
bash scripts/install-hooks.sh
# Muestra el fragmento JSON en stdout para fusionar manualmente en ~/.claude/settings.json
```

#### 5. Verificar

Reinicia Claude Code y manten una conversacion.
Deberia aparecer `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md`.

> **Hasta aqui son los pasos obligatorios.** Los siguientes son opcionales, pero recomendados para aprovechar al maximo.

#### 6. Configurar la ejecucion programada (recomendado)

Configura Ingest automatico (diario) y Lint (mensual).

```bash
# Detecta automaticamente el SO: macOS → LaunchAgent, Linux → cron
bash scripts/install-schedule.sh

# Prueba primero con DRY RUN
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **Nota para macOS**: Colocar el repositorio en `~/Documents/` o `~/Desktop/` puede hacer que TCC (Transparency, Consent, Control) bloquee el acceso en segundo plano con EPERM. Usa una ruta fuera de los directorios protegidos (por ejemplo, `~/_PROJECT/`).

Para ejecutar manualmente una sola vez, ejecuta los scripts directamente — se ejecutara el mismo procesamiento.

#### 7. Configurar el motor de busqueda qmd (opcional)

Habilita la busqueda de texto completo y semantica del Wiki mediante MCP.

```bash
# Registro de coleccion qmd + indexacion inicial
bash scripts/setup-qmd.sh

# Servidor HTTP MCP de qmd como daemon de launchd (solo macOS)
bash scripts/install-qmd-daemon.sh
```

#### 8. Instalar los skills de Wiki Ingest (opcional)

Habilita `/wiki-ingest-all` (importacion masiva de proyectos) y `/wiki-ingest` (escaneo dirigido).

```bash
# Crea symlinks en ~/.claude/skills/
bash scripts/install-skills.sh
```

#### 9. Desplegar en maquinas adicionales

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Abre ~/kioku/main-kioku/ como Vault en Obsidian
# Repite los pasos 2–6
```

<br>

## Estructura de directorios

```

├── README.md                        ← Este archivo
├── hooks/
│   ├── session-logger.mjs           ← Punto de entrada del Hook (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: inyecta wiki/index.md en el prompt del sistema
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Comando slash para importacion masiva de proyecto al Wiki
│   └── wiki-ingest/SKILL.md         ← Comando slash para escaneo dirigido
├── templates/
│   ├── vault/                       ← Archivos raiz del Vault (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Plantillas de notas (concept, project, decision, source-summary)
│   ├── wiki/                        ← Archivos iniciales del wiki (index.md, log.md)
│   └── launchd/*.plist.template     ← Plantillas de macOS LaunchAgent
├── scripts/
│   ├── setup-vault.sh               ← Inicializacion del Vault (idempotente)
│   ├── install-hooks.sh             ← Salida del fragmento de configuracion del Hook / --apply para fusion automatica
│   ├── auto-ingest.sh               ← Programado: ingesta de logs no procesados al wiki
│   ├── auto-lint.sh                 ← Programado: informe de salud del wiki + escaneo de secretos
│   ├── install-cron.sh              ← Muestra entradas de cron en stdout
│   ├── install-schedule.sh          ← Despachador segun SO (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← Instalador de macOS LaunchAgent
│   ├── setup-qmd.sh                 ← Registro de coleccion qmd + indexacion inicial
│   ├── install-qmd-daemon.sh        ← Servidor HTTP MCP de qmd como daemon de launchd
│   ├── install-skills.sh            ← Enlace simbolico de skills wiki-ingest a ~/.claude/skills/
│   └── scan-secrets.sh              ← Deteccion de fugas de secretos en session-logs/
└── tests/                           ← node --test y pruebas de humo en bash
```

<br>

## Variables de entorno

| Variable | Valor predeterminado | Proposito |
|---|---|---|
| `OBSIDIAN_VAULT` | ninguno (requerido) | Raiz del Vault. auto-ingest/lint recurren a `${HOME}/kioku/main-kioku` como alternativa |
| `KIOKU_DRY_RUN` | `0` | `1` para omitir llamadas a `claude -p` (solo verificacion de rutas) |
| `KIOKU_NO_LOG` | no definido | `1` para suprimir session-logger.mjs (previene el registro recursivo desde subprocesos de cron) |
| `KIOKU_DEBUG` | no definido | `1` para emitir informacion de depuracion a stderr y `session-logs/.kioku/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ruta del log de Ingest (referenciado por el autodiagnostico de auto-lint) |

### Configuracion de PATH para gestores de versiones de Node

Los scripts programados (`auto-ingest.sh`, `auto-lint.sh`) se ejecutan desde cron / LaunchAgent y no heredan el PATH de tu shell interactiva. Anaden Volta (`~/.volta/bin`) y mise (`~/.local/share/mise/shims`) al PATH. **Si usas nvm / fnm / asdf u otro gestor de versiones**, edita la linea `export PATH=...` en la parte superior de cada script:

```bash
# ejemplo con nvm
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# ejemplo con fnm
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Notas de diseno

- **Los logs de sesion contienen secretos**: Los prompts y la salida de herramientas pueden incluir claves API, tokens o informacion personal. `session-logger.mjs` aplica enmascaramiento con expresiones regulares antes de escribir
- **Limite de escritura**: Los Hooks solo escriben en `$OBSIDIAN_VAULT/session-logs/`. Nunca tocan `raw-sources/`, `wiki/` ni `templates/`
- **session-logs nunca llega a Git**: Excluido por `.gitignore`, minimizando el riesgo de envios accidentales a GitHub
- **Sin acceso a la red**: Los scripts de hooks (`session-logger.mjs`) no importan `http`/`https`/`net`/`dgram`. La sincronizacion Git se maneja con comandos shell de una linea en la configuracion del Hook
- **Idempotente**: `setup-vault.sh` / `install-hooks.sh` pueden ejecutarse multiples veces sin destruir archivos existentes
- **Sin git init**: `setup-vault.sh` no inicializa un repositorio Git ni anade remotos. La autenticacion con GitHub es responsabilidad del usuario

<br>

## Seguridad

KIOKU es un sistema de Hooks que accede a **toda la E/S de las sesiones de Claude Code**.
Consulta [SECURITY.md](SECURITY.md) para el diseno de seguridad completo.

### Capas de defensa

| Capa | Descripcion |
|---|---|
| **Validacion de entrada** | La ruta de `OBSIDIAN_VAULT` se verifica en busca de metacaracteres de shell y caracteres de control JSON/XML |
| **Enmascaramiento** | Claves API (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), autenticacion Bearer/Basic, credenciales en URL, claves privadas PEM se reemplazan con `***` |
| **Permisos** | `session-logs/` se crea con `0o700`, archivos de log con `0o600`. Los scripts de hooks se configuran con `chmod 755` |
| **Proteccion .gitignore** | Verifica que `.gitignore` contenga `session-logs/` antes de cada git commit |
| **Prevencion de recursion** | `KIOKU_NO_LOG=1` + verificacion de cwd-in-vault (doble proteccion) previene el registro recursivo desde subprocesos |
| **Restriccion de permisos del LLM** | auto-ingest / auto-lint ejecutan `claude -p` con `--allowedTools Write,Read,Edit` (sin Bash) |
| **Escaneo periodico** | `scan-secrets.sh` escanea session-logs/ mensualmente en busca de patrones de tokens conocidos para detectar fallos de enmascaramiento |

### Anadir patrones de tokens

Cuando empieces a usar un nuevo servicio en la nube, anade su patron de token tanto a `hooks/session-logger.mjs` (`MASK_RULES`) como a `scripts/scan-secrets.sh` (`PATTERNS`).

### Reportar vulnerabilidades

Si encuentras un problema de seguridad, reportalo a traves de [SECURITY.md](SECURITY.md) — no mediante Issues publicos.

<br>

## Configuracion multi-maquina

KIOKU esta disenado para **compartir una sola Wiki entre multiples maquinas** a traves de sincronizacion Git.
El autor utiliza una configuracion de dos Mac: un MacBook (maquina de desarrollo principal) y un Mac mini (para el modo bypass permission de Claude Code).

Puntos clave para la operacion multi-maquina:
- **`session-logs/` permanece local en cada maquina** (excluido por `.gitignore`). Los registros de sesion de cada maquina son independientes y nunca se envian a Git
- **`wiki/` esta sincronizado con Git**. Los resultados de Ingest de cualquier maquina se acumulan en la misma Wiki
- **Escalonar los tiempos de ejecucion de Ingest/Lint** entre maquinas para evitar conflictos en git push
- El auto commit/push del Hook SessionEnd esta habilitado en todas las maquinas, pero las sesiones de codificacion normales solo escriben en `session-logs/` — las operaciones git solo se activan cuando `wiki/` se modifica directamente

Referencia: configuracion de dos Mac del autor

| | MacBook (principal) | Mac mini (bypass) |
|---|---|---|
| Secretos | Si | No |
| `session-logs/` | Solo local | Solo local |
| `wiki/` | Sincronizado con Git | Sincronizado con Git |
| Horario de Ingest | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Horario de Lint | 1ro del mes 8:00 | 2do del mes 8:00 |
| Programador | LaunchAgent | LaunchAgent |

> Si ejecutas en una sola maquina, puedes ignorar esta seccion por completo. Los pasos del Inicio rapido son todo lo que necesitas.

<br>

## Hoja de ruta

### Corto plazo
- [ ] **Ajuste de calidad de Ingest** — Revisar y ajustar los criterios de seleccion en Vault CLAUDE.md despues de 2 semanas de ejecuciones reales de Ingest
- [ ] **Busqueda multilingue qmd** — Verificar la precision de busqueda semantica para contenido no anglofono; cambiar el modelo de embeddings si es necesario (por ejemplo, `multilingual-e5-small`)
- [ ] **Skill de auto-correccion segura (`/wiki-fix-safe`)** — Auto-corregir problemas triviales de Lint (agregar enlaces cruzados faltantes, completar vacios de frontmatter) con aprobacion humana
- [ ] **Visibilidad de errores de sincronizacion Git** — Registrar fallos de `git push` en `session-logs/.kioku/git-sync.log` y mostrar advertencias en auto-ingest

### Mediano plazo
- [ ] **Soporte multi-LLM** — Reemplazar `claude -p` en auto-ingest/lint con un backend LLM conectable (API de OpenAI, modelos locales via Ollama, etc.)
- [ ] **CI/CD** — GitHub Actions para pruebas automatizadas en cada push
- [ ] **Notificaciones de diferencias de Lint** — Mostrar solo los problemas *recien detectados* comparando con el reporte de lint anterior
- [ ] **Bloqueo optimista para index.json** — Prevenir actualizaciones perdidas cuando multiples sesiones de Claude Code se ejecutan en paralelo

### Largo plazo
- [ ] **Resumen matutino** — Generar automaticamente un resumen diario (sesiones de ayer, decisiones abiertas, nuevos conocimientos) como `wiki/daily/YYYY-MM-DD.md`
- [ ] **Inyeccion de contexto por proyecto** — Filtrar `wiki/index.md` segun el proyecto actual (basado en `cwd`) para mantenerse dentro del limite de 10,000 caracteres
- [ ] **Skill de recomendacion de stack (`/wiki-suggest-stack`)** — Sugerir stacks tecnologicos para nuevos proyectos basandose en el conocimiento acumulado del Wiki
- [ ] **Wiki de equipo** — Comparticion de Wiki entre multiples personas (los session-logs de cada miembro permanecen locales; solo wiki/ se comparte via Git)

> **Nota**: KIOKU actualmente requiere **Claude Code (plan Max)**. El sistema de Hooks (L0) y la inyeccion de contexto del Wiki son especificos de Claude Code. El pipeline de Ingest/Lint (L1/L2) puede funcionar con otras APIs de LLM sustituyendo la llamada a `claude -p` — esto esta planificado como una mejora futura.

<br>

## Licencia

Este proyecto esta licenciado bajo la Licencia MIT. Consulta [LICENSE](LICENSE) para mas detalles.

Como se indica en la seccion "Notas importantes" anterior, este software se proporciona "tal cual" sin garantia de ningun tipo.

<br>

## Referencias

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — El concepto original que este proyecto implementa
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Documentacion oficial del sistema de Hooks
- [Obsidian](https://obsidian.md/) — La aplicacion de gestion del conocimiento utilizada como visor del Wiki
- [qmd](https://github.com/tobi/qmd) — Motor de busqueda local para Markdown (BM25 + busqueda vectorial)


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## Autor

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Construyendo cosas con codigo e IA. Ingeniero freelance con 10 anos de experiencia. Enfocado en frontend, ultimamente co-desarrollando con Claude como mi flujo de trabajo principal.

[Sigueme en X](https://x.com/megaphone_tokyo)
