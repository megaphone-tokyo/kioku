## Este manual esta disponivel em varios idiomas

> [!NOTE]
> **🌐 Outros idiomas:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · 🇧🇷 **Português** · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

O Claude Code esquece o conhecimento de sessoes anteriores conforme elas terminam.
O kioku **acumula automaticamente suas conversas em uma Wiki** e **as recupera na proxima sessao**.

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
> kioku atualmente requer **Claude Code (plano Max)**. O sistema de Hook (L0) e a injecao de contexto da Wiki sao funcionalidades especificas do Claude Code. O pipeline de Ingest/Lint (L1/L2) pode funcionar com outras APIs de LLM substituindo a chamada `claude -p` — isso esta planejado como uma melhoria futura.

> [!IMPORTANT]
> Este software e fornecido **"como esta"**, sem garantia de qualquer tipo. Os autores nao assumem **nenhuma responsabilidade** por qualquer perda de dados, incidentes de seguranca ou danos decorrentes do uso desta ferramenta. Use por sua conta e risco. Consulte [LICENSE](LICENSE) para os termos completos.

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
> **Entenda antes de instalar:** KIOKU se conecta a **toda a E/S das sessoes do Claude Code**. Isso significa:
> - Os logs de sessao podem conter **chaves de API, tokens ou informacoes pessoais** dos seus prompts e saidas de ferramentas. O mascaramento cobre os padroes principais, mas nao e exaustivo — consulte [SECURITY.md](SECURITY.md)
> - Se o `.gitignore` estiver mal configurado, os logs de sessao podem ser **enviados acidentalmente para o GitHub**
> - O pipeline de auto-ingest envia o conteudo dos logs de sessao para o Claude via `claude -p` para extracao ao Wiki
>
> Recomendamos comecar com `KIOKU_DRY_RUN=1` para verificar o pipeline antes de habilitar a operacao completa.

### 🚀 Configuracao Interativa (Recomendada)

> [!NOTE]
> Digite o seguinte no Claude Code para iniciar uma configuracao interativa e guiada. Ela explica o proposito de cada etapa e se adapta ao seu ambiente.

```
Please read skills/setup-guide/SKILL.md and guide me through the KIOKU installation.
```

### 🛠️ Configuracao Manual

> [!NOTE]
> Para quem quer entender cada etapa. Execute os scripts diretamente.

#### 1. Criar um Vault e conecta-lo a um repositorio Git (manual)

1. Crie um novo Vault no Obsidian (ex.: `~/kioku/main-kioku`)
2. Crie um repositorio privado no GitHub (ex.: `kioku`)
3. No diretorio do Vault: `git init && git remote add origin ...` (ou `gh repo create --private --source=. --push`)

Esta etapa nao e automatizada pelos scripts do KIOKU. A autenticacao no GitHub (gh CLI / chaves SSH) depende do seu ambiente.

#### 2. Definir a variavel de ambiente

```bash
# Adicione ao ~/.zshrc ou ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Inicializar o Vault

```bash
# Cria raw-sources/, session-logs/, wiki/, templates/ dentro do Vault,
# coloca CLAUDE.md / .gitignore / templates iniciais (nunca sobrescreve arquivos existentes)
bash scripts/setup-vault.sh
```

#### 4. Instalar os Hooks

```bash
# Opcao A: Merge automatico (recomendado, requer jq)
bash scripts/install-hooks.sh --apply
# Cria backup → mostra diff → prompt de confirmacao → adiciona entradas de hook preservando a configuracao existente

# Opcao B: Merge manual
bash scripts/install-hooks.sh
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
bash scripts/install-schedule.sh

# Teste primeiro com DRY RUN
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **Nota para macOS**: Colocar o repositorio em `~/Documents/` ou `~/Desktop/` pode fazer com que o TCC (Transparency, Consent, Control) bloqueie o acesso em segundo plano com EPERM. Use um caminho fora de diretorios protegidos (ex.: `~/_PROJECT/`).

#### 7. Configurar o motor de busca qmd (opcional)

Habilite busca full-text e semantica para a Wiki via MCP.

```bash
bash scripts/setup-qmd.sh
bash scripts/install-qmd-daemon.sh
```

#### 8. Instalar skills de Wiki Ingest (opcional)

```bash
bash scripts/install-skills.sh
```

#### 9. Implantar em maquinas adicionais

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Abra ~/kioku/main-kioku/ como um Vault no Obsidian
# Repita os passos 2-6
```

<br>

## Estrutura de Diretorios

```

├── README.md                        ← Este arquivo
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
| `OBSIDIAN_VAULT` | nenhum (obrigatorio) | Raiz do Vault. auto-ingest/lint usa `${HOME}/kioku/main-kioku` como fallback |
| `KIOKU_DRY_RUN` | `0` | `1` para pular chamadas `claude -p` (apenas verificacao de caminho) |
| `KIOKU_NO_LOG` | nao definido | `1` para suprimir session-logger.mjs (previne logging recursivo de subprocessos do cron) |
| `KIOKU_DEBUG` | nao definido | `1` para emitir informacoes de debug para stderr e `session-logs/.kioku/errors.log` |
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

O kioku foi projetado para **compartilhar uma unica Wiki entre multiplas maquinas** via sincronizacao Git.
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

kioku e um sistema de Hook que acessa **toda a E/S das sessoes do Claude Code**.
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
- [ ] **Visibilidade de erros de sincronizacao Git** — Registrar falhas de `git push` em `session-logs/.kioku/git-sync.log` e exibir avisos no auto-ingest

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

> **Nota**: kioku atualmente requer **Claude Code (plano Max)**. O sistema de Hook (L0) e a injecao de contexto da Wiki sao especificos do Claude Code. O pipeline de Ingest/Lint (L1/L2) pode funcionar com outras APIs de LLM substituindo a chamada `claude -p` — isso esta planejado como uma melhoria futura.

<br>

## Licenca

Este projeto esta licenciado sob a Licenca MIT. Consulte [LICENSE](LICENSE) para detalhes.

Como indicado na secao "Notas Importantes" acima, este software e fornecido "como esta" sem garantia de qualquer tipo.

<br>

## Referencias

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — O conceito original que este projeto implementa
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Documentacao oficial do sistema de Hooks
- [Obsidian](https://obsidian.md/) — O aplicativo de gestao de conhecimento usado como visualizador da Wiki
- [qmd](https://github.com/tobi/qmd) — Motor de busca local para Markdown (BM25 + busca vetorial)

<br>


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## Autor

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Construindo coisas com codigo e IA. Engenheiro freelancer, 10 anos de experiencia. Focado em frontend, ultimamente co-desenvolvendo com Claude como meu fluxo de trabalho principal.

[Siga-me no X](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
