## Este manual esta disponivel em varios idiomas

> [!NOTE]
> **🌐 Outros idiomas:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · 🇧🇷 **Português** · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

O Claude Code esquece o conhecimento de sessoes anteriores conforme elas terminam.
O claude-brain **acumula automaticamente suas conversas em uma Wiki** e **as recupera na proxima sessao**.

Chega de repetir as mesmas explicacoes. Um "segundo cerebro" que cresce a cada uso — para o seu Claude.

<br>

## O Que Faz

Registre automaticamente sessoes do Claude Code e construa uma base de conhecimento estruturada em um Obsidian Vault. Combina o padrao LLM Wiki de Andrej Karpathy com logging automatico e sincronizacao Git entre multiplas maquinas.

```
🗣️  Converse com o Claude Code normalmente
         ↓  （tudo e registrado automaticamente — voce nao precisa fazer nada）
📝  Logs das sessoes sao salvos localmente
         ↓  （um job agendado pede a IA para ler os logs e extrair conhecimento）
📚  A Wiki cresce a cada sessao — conceitos, decisoes, padroes
         ↓  （sincronizado via Git）
☁️  GitHub mantem sua Wiki com backup e compartilhada entre maquinas
```

1. **Captura automatica (L0)**: Captura eventos de hook do Claude Code (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) e grava Markdown em `session-logs/`
2. **Estruturacao (L1)**: Execucao agendada (macOS LaunchAgent / Linux cron) faz o LLM ler logs nao processados e construir paginas de conceitos, paginas de projetos e decisoes de design em `wiki/`. Insights das sessoes tambem sao salvos em `wiki/analyses/`
3. **Verificacao de integridade (L2)**: Verificacao mensal de saude da wiki gera `wiki/lint-report.md`. Inclui deteccao automatica de vazamento de segredos
4. **Sincronizacao (L3)**: O proprio Vault e um repositorio Git. `SessionStart` executa `git pull`, `SessionEnd` executa `git commit && git push`, sincronizando entre maquinas via repositorio privado no GitHub
5. **Injecao de contexto da wiki**: No `SessionStart`, `wiki/index.md` e injetado no prompt do sistema para que o Claude aproveite conhecimento anterior
6. **Busca full-text via qmd**: Pesquise na wiki via MCP com BM25 + busca semantica
7. **Skills de Wiki Ingest**: Comandos slash `/wiki-ingest-all` e `/wiki-ingest` importam conhecimento existente de projetos para a Wiki
8. **Isolamento de segredos**: `session-logs/` permanece local por maquina (`.gitignore`). Apenas `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` sao gerenciados pelo Git

<br>

## Notas Importantes

> [!CAUTION]
> claude-brain atualmente requer **Claude Code (plano Max)**. O sistema de Hook (L0) e a injecao de contexto da Wiki sao funcionalidades especificas do Claude Code. O pipeline de Ingest/Lint (L1/L2) pode funcionar com outras APIs de LLM substituindo a chamada `claude -p` — isso esta planejado como uma melhoria futura.

> [!IMPORTANT]
> Este software e fornecido **"como esta"**, sem garantia de qualquer tipo. Os autores nao assumem **nenhuma responsabilidade** por qualquer perda de dados, incidentes de seguranca ou danos decorrentes do uso desta ferramenta. Use por sua conta e risco. Consulte [LICENSE](../../LICENSE) para os termos completos.

<br>

## Pre-requisitos

| | Versao / Requisito |
|---|---|
| macOS | 13+ recomendado |
| Node.js | 18+ (scripts de hook sao `.mjs` ES Modules, sem dependencias externas) |
| Bash | 3.2+ (padrao do macOS) |
| Git | 2.x+. Deve suportar `git pull --rebase` / `git push` |
| GitHub CLI | Opcional (`gh` simplifica a criacao de repositorios privados) |
| Claude Code | **Plano Max** obrigatorio (usa `claude` CLI e o sistema de Hook em `~/.claude/settings.json`) |
| Obsidian | Um Vault criado em qualquer pasta (iCloud Drive nao e necessario) |
| jq | 1.6+ (usado por `install-hooks.sh --apply`) |
| Variavel de ambiente | `OBSIDIAN_VAULT` apontando para a raiz do Vault |

<br>

## Inicio Rapido

> [!WARNING]
> **Entenda antes de instalar:** claude-brain se conecta a **toda a E/S das sessoes do Claude Code**. Isso significa:
> - Os logs de sessao podem conter **chaves de API, tokens ou informacoes pessoais** dos seus prompts e saidas de ferramentas. O mascaramento cobre os padroes principais, mas nao e exaustivo — consulte [SECURITY.md](SECURITY.md)
> - Se o `.gitignore` estiver mal configurado, os logs de sessao podem ser **enviados acidentalmente para o GitHub**
> - O pipeline de auto-ingest envia o conteudo dos logs de sessao para o Claude via `claude -p` para extracao ao Wiki
>
> Recomendamos comecar com `KIOKU_DRY_RUN=1` para verificar o pipeline antes de habilitar a operacao completa.

### 🚀 Configuracao Interativa (Recomendada)

> [!NOTE]
> Digite o seguinte no Claude Code para iniciar uma configuracao interativa e guiada. Ela explica o proposito de cada etapa e se adapta ao seu ambiente.

```
Please read tools/claude-brain/skills/setup-guide/SKILL.md and guide me through the claude-brain installation.
```

### 🛠️ Configuracao Manual

> [!NOTE]
> Para quem quer entender cada etapa. Execute os scripts diretamente.

#### 1. Criar um Vault e conecta-lo a um repositorio Git (manual)

1. Crie um novo Vault no Obsidian (ex.: `~/claude-brain/main-claude-brain`)
2. Crie um repositorio privado no GitHub (ex.: `claude-brain`)
3. No diretorio do Vault: `git init && git remote add origin ...` (ou `gh repo create --private --source=. --push`)

Esta etapa nao e automatizada pelos scripts do claude-brain. A autenticacao no GitHub (gh CLI / chaves SSH) depende do seu ambiente.

#### 2. Definir a variavel de ambiente

```bash
# Adicione ao ~/.zshrc ou ~/.bashrc
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

#### 3. Inicializar o Vault

```bash
# Cria raw-sources/, session-logs/, wiki/, templates/ dentro do Vault,
# coloca CLAUDE.md / .gitignore / templates iniciais (nunca sobrescreve arquivos existentes)
bash tools/claude-brain/scripts/setup-vault.sh
```

#### 4. Instalar os Hooks

```bash
# Opcao A: Merge automatico (recomendado, requer jq)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# Cria backup → mostra diff → prompt de confirmacao → adiciona entradas de hook preservando a configuracao existente

# Opcao B: Merge manual
bash tools/claude-brain/scripts/install-hooks.sh
# Envia o trecho JSON para stdout para merge manual em ~/.claude/settings.json
```

#### 5. Verificar

Reinicie o Claude Code e tenha uma conversa.
O arquivo `$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` deve aparecer.

> **As etapas 1-5 sao obrigatorias.** As seguintes sao opcionais, mas recomendadas para funcionalidade completa.

#### 6. Configurar execucao agendada (recomendado)

Configure o Ingest automatico (diario) e o Lint (mensal).

```bash
# Detecta o SO automaticamente: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# Teste primeiro com DRY RUN
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **Nota para macOS**: Colocar o repositorio em `~/Documents/` ou `~/Desktop/` pode fazer com que o TCC (Transparency, Consent, Control) bloqueie o acesso em segundo plano com EPERM. Use um caminho fora de diretorios protegidos (ex.: `~/_PROJECT/`).

#### 7. Configurar o motor de busca qmd (opcional)

Habilite busca full-text e semantica para a Wiki via MCP.

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

#### 8. Instalar skills de Wiki Ingest (opcional)

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

#### 9. Implantar em maquinas adicionais

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# Abra ~/claude-brain/main-claude-brain/ como um Vault no Obsidian
# Repita os passos 2-6
```

<br>

## Estrutura de Diretorios

```
tools/claude-brain/
├── README.md                        ← Este arquivo
├── context/                         ← Implementacao atual (INDEX + docs por funcionalidade)
├── handoff/                         ← Notas de transicao para a proxima sessao
├── plan/
│   ├── user/                      ← Instrucoes de design do usuario
│   └── claude/                      ← Especificacoes de implementacao do Claude
├── hooks/
│   ├── session-logger.mjs           ← Ponto de entrada do Hook (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: injeta wiki/index.md no prompt do sistema
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Comando slash para importacao em massa de projetos para a Wiki
│   └── wiki-ingest/SKILL.md         ← Comando slash para varredura direcionada
├── templates/
│   ├── vault/                       ← Arquivos raiz do Vault (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Templates de notas (concept, project, decision, source-summary)
│   ├── wiki/                        ← Arquivos iniciais da wiki (index.md, log.md)
│   └── launchd/*.plist.template     ← Templates de LaunchAgent para macOS
├── scripts/
│   ├── setup-vault.sh               ← Inicializacao do Vault (idempotente)
│   ├── install-hooks.sh             ← Saida de snippet de configuracao de Hook / --apply para merge automatico
│   ├── auto-ingest.sh               ← Agendado: ingere logs nao processados na wiki
│   ├── auto-lint.sh                 ← Agendado: relatorio de saude da wiki + varredura de segredos
│   ├── install-cron.sh              ← Envia entradas de cron para stdout
│   ├── install-schedule.sh          ← Dispatcher consciente do SO (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← Instalador de LaunchAgent para macOS
│   ├── setup-qmd.sh                 ← Registro de colecao qmd + indexacao inicial
│   ├── install-qmd-daemon.sh        ← Servidor HTTP MCP qmd como daemon launchd
│   ├── install-skills.sh            ← Symlink das skills wiki-ingest para ~/.claude/skills/
│   └── scan-secrets.sh              ← Deteccao de vazamento de segredos em session-logs/
└── tests/                           ← node --test e testes smoke em bash
```

<br>

## Variaveis de Ambiente

| Variavel | Padrao | Finalidade |
|---|---|---|
| `OBSIDIAN_VAULT` | nenhum (obrigatorio) | Raiz do Vault. auto-ingest/lint usa `${HOME}/claude-brain/main-claude-brain` como fallback |
| `KIOKU_DRY_RUN` | `0` | `1` para pular chamadas `claude -p` (apenas verificacao de caminho) |
| `KIOKU_NO_LOG` | nao definido | `1` para suprimir session-logger.mjs (previne logging recursivo de subprocessos do cron) |
| `KIOKU_DEBUG` | nao definido | `1` para emitir informacoes de debug para stderr e `session-logs/.claude-brain/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Caminho de saida do log de Ingest (referenciado pelos diagnosticos do auto-lint) |

### Configuracao de PATH para Gerenciador de Versoes do Node

Scripts agendados (`auto-ingest.sh`, `auto-lint.sh`) sao executados pelo cron / LaunchAgent e nao herdam o PATH do seu shell interativo. Eles adicionam Volta (`~/.volta/bin`) e mise (`~/.local/share/mise/shims`) ao PATH. **Se voce usa nvm / fnm / asdf ou outro gerenciador de versoes**, edite a linha `export PATH=...` no inicio de cada script:

```bash
# exemplo com nvm
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# exemplo com fnm
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Notas de Design

- **Logs de sessao contem segredos**: Prompts e saidas de ferramentas podem incluir chaves de API, tokens ou PII. `session-logger.mjs` aplica mascaramento via regex antes de gravar
- **Limite de escrita**: Hooks gravam apenas em `$OBSIDIAN_VAULT/session-logs/`. Nunca tocam em `raw-sources/`, `wiki/` ou `templates/`
- **session-logs nunca chegam ao Git**: Excluidos pelo `.gitignore`, minimizando o risco de pushes acidentais para o GitHub
- **Sem acesso a rede**: Scripts de hook (`session-logger.mjs`) nao importam `http`/`https`/`net`/`dgram`. A sincronizacao via Git e feita por one-liners em shell na configuracao do Hook
- **Idempotente**: `setup-vault.sh` / `install-hooks.sh` podem ser executados multiplas vezes sem destruir arquivos existentes
- **Sem git init**: `setup-vault.sh` nao inicializa um repositorio Git nem adiciona remotes. A autenticacao no GitHub e responsabilidade do usuario

<br>

## Configuracao Multi-Maquina

O claude-brain foi projetado para **compartilhar uma unica Wiki entre multiplas maquinas** via sincronizacao Git.
O autor usa uma configuracao com dois Macs: um MacBook (maquina de desenvolvimento principal) e um Mac mini (para o modo bypass permission do Claude Code).

Pontos-chave para operacao multi-maquina:
- **`session-logs/` permanece local em cada maquina** (excluido pelo `.gitignore`). Os logs de sessao de cada maquina sao independentes e nunca sao enviados ao Git
- **`wiki/` e sincronizado via Git**. Os resultados de Ingest de qualquer maquina se acumulam na mesma Wiki
- **Escalone os horarios de execucao de Ingest/Lint** entre maquinas para evitar conflitos de git push
- O auto commit/push do Hook SessionEnd esta habilitado em todas as maquinas, mas sessoes normais de codigo so escrevem em `session-logs/` — operacoes git so sao acionadas quando `wiki/` e modificado diretamente

Referencia: configuracao de dois Macs do autor

| | MacBook (principal) | Mac mini (bypass) |
|---|---|---|
| Segredos | Sim | Nao |
| `session-logs/` | Apenas local | Apenas local |
| `wiki/` | Git-sincronizado | Git-sincronizado |
| Horario Ingest | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Horario Lint | 1o do mes 8:00 | 2o do mes 8:00 |
| Agendador | LaunchAgent | LaunchAgent |

> Se voce usa apenas uma maquina, pode ignorar esta secao completamente. Os passos do Inicio Rapido sao tudo o que voce precisa.

<br>

## Seguranca

claude-brain e um sistema de Hook que acessa **toda a E/S das sessoes do Claude Code**.
Consulte [SECURITY.md](SECURITY.md) para o design completo de seguranca.

### Camadas de Defesa

| Camada | Descricao |
|---|---|
| **Validacao de entrada** | Caminho de `OBSIDIAN_VAULT` verificado contra metacaracteres de shell e caracteres de controle JSON/XML |
| **Mascaramento** | Chaves de API (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), autenticacao Bearer/Basic, credenciais em URLs, chaves privadas PEM substituidas por `***` |
| **Permissoes** | `session-logs/` criado com `0o700`, arquivos de log com `0o600`. Scripts de hook definidos com `chmod 755` |
| **Protecao via .gitignore** | Verifica se `.gitignore` contem `session-logs/` antes de cada git commit |
| **Prevencao de recursao** | `KIOKU_NO_LOG=1` + verificacao de cwd-in-vault (dupla protecao) previne logging recursivo de subprocessos |
| **Restricao de permissao do LLM** | auto-ingest / auto-lint executam `claude -p` com `--allowedTools Write,Read,Edit` (sem Bash) |
| **Varredura periodica** | `scan-secrets.sh` faz varredura mensal em session-logs/ buscando padroes de tokens conhecidos para detectar falhas de mascaramento |

### Adicionando Padroes de Tokens

Quando voce comecar a usar um novo servico de nuvem, adicione o padrao do token tanto em `hooks/session-logger.mjs` (`MASK_RULES`) quanto em `scripts/scan-secrets.sh` (`PATTERNS`).

### Reportando Vulnerabilidades

Se voce encontrar um problema de seguranca, por favor reporte via [SECURITY.md](SECURITY.md) -- e nao por Issues publicas.

<br>

## Roteiro

### Curto prazo
- [ ] **Ajuste de qualidade do Ingest** — Revisar e ajustar criterios de selecao no Vault CLAUDE.md apos 2 semanas de execucoes reais de Ingest
- [ ] **Busca multilingue qmd** — Verificar a precisao da busca semantica para conteudo nao ingles; trocar modelo de embeddings se necessario (ex., `multilingual-e5-small`)
- [ ] **Skill de auto-correcao segura (`/wiki-fix-safe`)** — Auto-corrigir problemas triviais de Lint (adicionar links cruzados faltantes, preencher gaps de frontmatter) com aprovacao humana
- [ ] **Visibilidade de erros de sincronizacao Git** — Registrar falhas de `git push` em `session-logs/.claude-brain/git-sync.log` e exibir avisos no auto-ingest

### Medio prazo
- [ ] **Suporte multi-LLM** — Substituir `claude -p` no auto-ingest/lint por um backend LLM plugavel (OpenAI API, modelos locais via Ollama, etc.)
- [ ] **CI/CD** — GitHub Actions para testes automatizados em push
- [ ] **Notificacoes de diff de Lint** — Mostrar apenas problemas *recem-detectados* comparando com o relatorio de lint anterior
- [ ] **Bloqueio otimista para index.json** — Prevenir atualizacoes perdidas quando multiplas sessoes do Claude Code rodam em paralelo

### Longo prazo
- [ ] **Briefing matinal** — Gerar automaticamente um resumo diario (sessoes de ontem, decisoes em aberto, novos insights) como `wiki/daily/YYYY-MM-DD.md`
- [ ] **Injecao de contexto por projeto** — Filtrar `wiki/index.md` pelo projeto atual (baseado em `cwd`) para manter dentro do limite de 10.000 caracteres
- [ ] **Skill de recomendacao de stack (`/wiki-suggest-stack`)** — Sugerir stacks tecnologicos para novos projetos com base no conhecimento acumulado da Wiki
- [ ] **Wiki de equipe** — Compartilhamento de Wiki entre multiplas pessoas (session-logs de cada membro ficam locais; apenas wiki/ e compartilhado via Git)

> **Nota**: claude-brain atualmente requer **Claude Code (plano Max)**. O sistema de Hook (L0) e a injecao de contexto da Wiki sao especificos do Claude Code. O pipeline de Ingest/Lint (L1/L2) pode funcionar com outras APIs de LLM substituindo a chamada `claude -p` — isso esta planejado como uma melhoria futura.

<br>

## Histórico de mudanças

### 2026-04-23 — v0.5.1: Hot cache + hook PostCompact + prompt Stop opt-in

- **Padrão hot cache** — Novo `wiki/hot.md` (<=500 palavras, limite rígido de 4000 caracteres) injetado automaticamente no **SessionStart** e reinjetado após **PostCompact** (compactação de contexto), para que o LLM retenha o contexto de trabalho de curto prazo entre sessões e compactações. Inspirado no padrão UX do claude-obsidian
- **Hook PostCompact** — `install-hooks.sh` agora conecta um 6º evento (`PostCompact`) que reinjeta apenas hot.md (index.md já está no contexto após compactação, então é omitido para evitar inchaço de tokens)
- **Prompt Stop opt-in** (`KIOKU_HOT_AUTO_PROMPT=1`) — Quando definido explicitamente, o fim de sessão dispara uma sugestão de atualização para hot.md. **Padrão OFF** — hot.md é sincronizado por Git e tem uma fronteira de segurança mais estrita que session-logs, portanto o prompt automático requer consentimento explícito do usuário
- **Fronteira de segurança mantida** — hot.md passa por `applyMasks()` (mascaramento de padrões API key / token) antes da injeção, está no alvo do walk do scan-secrets.sh, rejeita symlink escape via `realpath` (caminhos fora do vault rejeitados) e trunca em 4000 caracteres com log WARN
- **Alinhamento de schema de hook Claude Code v2 (4 hotfixes)** — Claude Code v2 usa schemas de saída diferentes por evento: `hookSpecificOutput` só é suportado para `PreToolUse` / `UserPromptSubmit` / `PostToolUse`; `PostCompact` e `Stop` devem usar `systemMessage` de nível superior. O antigo v1 flat `{additionalContext}` é silenciosamente descartado no v2. Hotfixes 1-4 migram toda a saída de hook para o schema correto por evento
- Testes: **47 asserções Node** (HOT-1..9d + HOT-V1/V2 + regressão session-logger + H1-H5 injector) **+ 488 asserções Bash** (IH-PC1/2 + SS-H1 + cron-guard-parity CGP-2 + 15 suites existentes), todos verdes
- [Release v0.5.1](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.1) — `kioku-wiki-0.5.1.mcpb` anexado (9.2 MB)

### 2026-04-23 — v0.5.0: Funcionalidade 2.4 — roteador unificado de ingest para PDF / MD / EPUB / DOCX

- **Fase 1** — Roteador `kioku_ingest_document`: uma ferramenta MCP unificada que despacha por extensão de arquivo (`.pdf` / `.md` / `.epub` / `.docx`) para o handler correto. O `kioku_ingest_pdf` existente passa a ser um alias depreciado mantido durante a janela v0.5 – v0.7; remoção planejada para v0.8
- **Fase 2** — Ingest de EPUB: extração segura via yauzl com defesa em 8 camadas (zip-slip / symlink / limite cumulativo de tamanho / limite de contagem de entradas / normalização NFKC de nome de arquivo / skip de ZIP aninhado / pré-scan XXE / sanitização de script XHTML). Capítulos ordenados pelo spine são convertidos em chunks Markdown (`readability-extract` + `turndown`), armazenados em `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`; EPUBs multi-capítulo também recebem um `-index.md`. Os resumos do LLM fluem pelo cron de auto-ingest de forma assíncrona
- **Fase 3** — Ingest de DOCX (MVP): arquitetura de duas camadas `mammoth + yauzl` (a superfície de ataque interna do jszip do mammoth é pré-protegida pela defesa de 8 camadas do yauzl). `word/document.xml` / `docProps/core.xml` passam por um pré-scan XXE (`assertNoDoctype`). Imagens (VULN-D004/D007) e conteúdo OLE embutido (VULN-D006) ficam para depois — o MVP extrai apenas corpo de texto + headings. Os metadados são delimitados por uma cerca `--- DOCX METADATA ---` com anotação **untrusted** para delimitar prompt injection contra o resumo LLM downstream
- **Hotfix pré-release** — Corrigida a regex de argv em `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs` para ser Unicode-aware (`\p{L}\p{N}`); o `\w` anterior (apenas ASCII) silenciosamente pulava nomes de arquivo em japonês / chinês como `論文.docx` / `日本語.epub` no caminho do cron de auto-ingest. O EPUB estava com essa regressão latente desde v0.4.0 e foi corrigido retroativamente (LEARN#6 cross-boundary drift). Adicionalmente, `meta` / `base` / `link` foram adicionados aos `DANGEROUS_TAGS` de `html-sanitize` como defesa em profundidade para futuros caminhos consumidores de EPUB
- **Known issue (não aplicável)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium) afeta a API **XMLBuilder** (XML writer). Esta codebase usa apenas **XMLParser** (XML reader) em `mcp/lib/xml-safe.mjs`, portanto a vulnerabilidade não é explorável. A dependência será atualizada para `fast-xml-parser@^5.7.0` na **v0.5.1** para limpar o alerta do dependabot
- Testes: **158 assertions Bash + suite Node completa verde** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / camada MCP 30). `npm audit` reporta **0 vulnerabilidades** nas dependências de runtime; relatórios paralelos red-hacker + blue-hacker `/security-review` indicam **0 achados HIGH/CRITICAL**
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` anexado (9,2 MB)

### 2026-04-21 — v0.4.0: revisão geral de Tier A (segurança + operações) + Tier B (limpeza)

- **A#1** — Atualizado `@mozilla/readability` 0.5 → 0.6 (ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7) mitigado; 144 dependências de produção passam `npm audit` sem problemas)
- **A#2** — Adicionada proteção `git symbolic-ref -q HEAD` em `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd, evitando commits descontrolados quando o Vault está em estado detached-HEAD (drift de 5 dias observado em uma máquina antes da correção)
- **A#3** — Refatoração de `withLock` (tempo de retenção reduzido de minutos para segundos), remoção completa da API `skipLock` e adição de limpeza de PDFs órfãos
- **B#1** — Reauditoria da camada de Hook (`session-logger.mjs`): corrigidos 3 findings MEDIUM (bypass de mascaramento via invisible-character, YAML injection em frontmatter, drift de strict-equality em `KIOKU_NO_LOG`)
- **B#2** — Paridade das guardas cron/setup formalizada como `tests/cron-guard-parity.test.sh` (17 assertions) para impor as convenções de env-override Category-A / Category-B
- **B#3** — Race cross-machine de `sync-to-app.sh` evitada por `check_github_side_lock` (α guard, janela padrão de 120s, configurável via `KIOKU_SYNC_LOCK_MAX_AGE`); regressão travada por `tests/sync-to-app.test.sh` (11 assertions)
- **B#8** — Paridade de i18n do README: seções §10 MCP / §11 MCPB / Changelog adicionadas a todos os 8 READMEs não-en/ja (+1384 linhas)
- Testes: **299 Node tests** + **15 Bash suites / 415 assertions**, todos verdes
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` anexado

### 2026-04-17 — Fase N: pacote MCPB para Claude Desktop
- Novo `mcp/manifest.json` (MCPB v0.4) e `scripts/build-mcpb.sh` produzem `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 MB)
- Usuários do Claude Desktop podem instalar o servidor MCP arrastando um único arquivo. `OBSIDIAN_VAULT` é configurado pelo seletor de diretório no diálogo de instalação (Node não é necessário na máquina do usuário — Desktop usa seu runtime embutido)
- Para instruções detalhadas, consulte [README.md](README.md) ou [README.ja.md](README.ja.md)

### 2026-04-17 — Fase M: servidor MCP kioku-wiki
- Servidor MCP local stdio (`tools/claude-brain/mcp/`) expondo seis ferramentas — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Claude Desktop e Claude Code agora podem navegar, pesquisar e atualizar o Wiki sem sair do chat
- Para configuração, consulte [README.md](README.md) ou [README.ja.md](README.ja.md)

### 2026-04-16 — Fase L: migração para macOS LaunchAgent
- O novo despachante `scripts/install-schedule.sh` seleciona LaunchAgent (macOS) ou cron (Linux) automaticamente

<br>

## Licenca

Este projeto esta licenciado sob a Licenca MIT. Consulte [LICENSE](../../LICENSE) para detalhes.

Como indicado na secao "Notas Importantes" acima, este software e fornecido "como esta" sem garantia de qualquer tipo.

<br>

## Referencias

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — O conceito original que este projeto implementa
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Documentacao oficial do sistema de Hooks
- [Obsidian](https://obsidian.md/) — O aplicativo de gestao de conhecimento usado como visualizador da Wiki
- [qmd](https://github.com/tobi/qmd) — Motor de busca local para Markdown (BM25 + busca vetorial)

<br>

## Autor

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Construindo coisas com codigo e IA. Engenheiro freelancer, 10 anos de experiencia. Focado em frontend, ultimamente co-desenvolvendo com Claude como meu fluxo de trabalho principal.

[Siga-me no X](https://x.com/megaphone_tokyo)
