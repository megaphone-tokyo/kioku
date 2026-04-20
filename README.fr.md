## Ce manuel est disponible en plusieurs langues

> [!NOTE]
> **🌐 Autres langues :** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · [🇰🇷 한국어](README.ko.md) · 🇫🇷 **Français** · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

Claude Code oublie les connaissances des sessions passees au fur et a mesure.
kioku **accumule automatiquement vos conversations dans un Wiki** et **les rappelle lors de la prochaine session**.

Plus besoin de repeter les memes explications encore et encore. Un « second cerveau » qui grandit a chaque utilisation — pour votre Claude.

<br>

## Fonctionnement

Enregistre automatiquement les sessions Claude Code et construit une base de connaissances structuree dans un Obsidian Vault. Combine le patron LLM Wiki d'Andrej Karpathy avec l'auto-logging et la synchronisation Git entre plusieurs machines.

```
🗣️  Discutez avec Claude Code comme d'habitude
         ↓  （tout est enregistre automatiquement — vous n'avez rien a faire）
📝  Les journaux de session sont sauvegardes localement
         ↓  （une tache planifiee demande a l'IA de lire les journaux et d'extraire les connaissances）
📚  Le Wiki grandit a chaque session — concepts, decisions, patterns
         ↓  （synchronise via Git）
☁️  GitHub sauvegarde votre Wiki et le partage entre vos machines
```

1. **Capture automatique (L0)** : Capture les evenements de hook Claude Code (`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`) et ecrit du Markdown dans `session-logs/`
2. **Structuration (L1)** : L'execution planifiee (macOS LaunchAgent / Linux cron) fait lire au LLM les logs non traites et construit des pages de concepts, des pages de projets et des decisions de conception dans `wiki/`. Les analyses de session sont egalement enregistrees dans `wiki/analyses/`
3. **Verification d'integrite (L2)** : Verification mensuelle de la sante du wiki generant `wiki/lint-report.md`. Detection automatique de fuites de secrets incluse
4. **Synchronisation (L3)** : Le Vault lui-meme est un depot Git. `SessionStart` execute `git pull`, `SessionEnd` execute `git commit && git push`, synchronisant entre machines via un depot prive GitHub
5. **Injection de contexte wiki** : A `SessionStart`, `wiki/index.md` est injecte dans le prompt systeme afin que Claude puisse exploiter les connaissances passees
6. **Recherche plein texte qmd** : Recherche dans le wiki via MCP avec BM25 + recherche semantique
7. **Ingest de sources externes (PDF / URL)** : `kioku_ingest_pdf` extrait et resume les PDF locaux places sous `raw-sources/` ; `kioku_ingest_url` recupere les articles HTTP(S) via Mozilla Readability, enregistre le Markdown + les images dans `raw-sources/<dir>/fetched/` et redirige automatiquement les URL PDF vers le pipeline PDF. Les PDF volumineux (≥ 2 chunks) utilisent un processus de resume `detached` pour repondre en ≤ 5 s (compatible avec le timeout de 60 s de Claude Desktop)
8. **Competences Wiki Ingest** : Les commandes slash `/wiki-ingest-all` et `/wiki-ingest` importent les connaissances de projets existants dans le Wiki
9. **Isolation des secrets** : `session-logs/` reste local sur chaque machine (`.gitignore`). Seuls `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md` sont geres par Git

<br>

## Notes importantes

> [!CAUTION]
> KIOKU necessite actuellement **Claude Code (plan Max)**. Le systeme de Hook (L0) et l'injection de contexte Wiki sont des fonctionnalites specifiques a Claude Code. Le pipeline Ingest/Lint (L1/L2) peut fonctionner avec d'autres API LLM en remplacant l'appel `claude -p` — ceci est prevu comme une amelioration future.

> [!IMPORTANT]
> Ce logiciel est fourni **« tel quel »**, sans garantie d'aucune sorte. Les auteurs n'assument **aucune responsabilite** pour toute perte de donnees, incident de securite ou dommage resultant de l'utilisation de cet outil. Utilisez-le a vos propres risques. Consultez [LICENSE](LICENSE) pour les conditions completes.

<br>

## Prerequis

| | Version / Exigence |
|---|---|
| macOS | 13+ recommande |
| Node.js | 18+ (les scripts de hook sont des modules ES `.mjs`, zero dependance externe) |
| Bash | 3.2+ (defaut macOS) |
| Git | 2.x+. Doit supporter `git pull --rebase` / `git push` |
| GitHub CLI | Optionnel (`gh` simplifie la creation de depots prives) |
| Claude Code | **Plan Max** requis (utilise `claude` CLI et le systeme de Hook dans `~/.claude/settings.json`) |
| Obsidian | Un Vault cree dans un dossier quelconque (iCloud Drive non requis) |
| jq | 1.6+ (utilise par `install-hooks.sh --apply`) |
| Var. d'env. | `OBSIDIAN_VAULT` pointant vers la racine du Vault |

<br>

## Demarrage rapide

> [!WARNING]
> **Comprenez avant d'installer :** KIOKU se connecte a **toutes les E/S des sessions Claude Code**. Cela signifie :
> - Les journaux de session peuvent contenir des **cles API, tokens ou informations personnelles** provenant de vos prompts et des sorties d'outils. Le masquage couvre les principaux patrons mais n'est pas exhaustif — consultez [SECURITY.md](SECURITY.md)
> - Si `.gitignore` est mal configure, les journaux de session pourraient etre **accidentellement pushes sur GitHub**
> - Le pipeline d'auto-ingest envoie le contenu des journaux de session a Claude via `claude -p` pour l'extraction vers le Wiki
>
> Nous recommandons de commencer avec `KIOKU_DRY_RUN=1` pour verifier le pipeline avant d'activer l'operation complete.

### 🚀 Configuration interactive (Recommandee)

> [!NOTE]
> Entrez ce qui suit dans Claude Code pour demarrer une configuration interactive et guidee. Elle explique le but de chaque etape et s'adapte a votre environnement.

```
Please read skills/setup-guide/SKILL.md and guide me through the KIOKU installation.
```

### 🛠️ Configuration manuelle

> [!NOTE]
> Pour ceux qui veulent comprendre chaque etape. Executez les scripts directement.

#### 1. Creer un Vault et le connecter a un depot Git (manuel)

1. Creer un nouveau Vault dans Obsidian (ex. : `~/kioku/main-kioku`)
2. Creer un depot prive sur GitHub (ex. : `kioku`)
3. Dans le repertoire du Vault : `git init && git remote add origin ...` (ou `gh repo create --private --source=. --push`)

Cette etape n'est pas automatisee par les scripts kioku. L'authentification GitHub (gh CLI / cles SSH) depend de votre environnement.

#### 2. Definir la variable d'environnement

```bash
# Ajouter a ~/.zshrc ou ~/.bashrc
export OBSIDIAN_VAULT="$HOME/kioku/main-kioku"
```

#### 3. Initialiser le Vault

```bash
# Cree raw-sources/, session-logs/, wiki/, templates/ dans le Vault,
# place CLAUDE.md / .gitignore / templates initiaux (n'ecrase jamais les fichiers existants)
bash scripts/setup-vault.sh
```

#### 4. Installer les Hooks

```bash
# Option A : Fusion automatique (recommandee, necessite jq)
bash scripts/install-hooks.sh --apply
# Cree une sauvegarde → affiche le diff → invite de confirmation → ajoute les entrees de hook en preservant la configuration existante

# Option B : Fusion manuelle
bash scripts/install-hooks.sh
# Affiche un extrait JSON sur stdout pour fusion manuelle dans ~/.claude/settings.json
```

#### 5. Verifier

Redemarrez Claude Code, puis ayez une conversation.
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md` devrait apparaitre.

> **Les etapes 1 a 5 sont obligatoires.** Les suivantes sont optionnelles mais recommandees pour une fonctionnalite complete.

#### 6. Configurer l'execution planifiee (recommande)

Configurez l'Ingest automatique (quotidien) et le Lint (mensuel).

```bash
# Detection automatique de l'OS : macOS → LaunchAgent, Linux → cron
bash scripts/install-schedule.sh

# Tester d'abord en mode DRY RUN
KIOKU_DRY_RUN=1 bash scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash scripts/auto-lint.sh
```

> **Note macOS** : Placer le depot sous `~/Documents/` ou `~/Desktop/` peut provoquer un blocage d'acces en arriere-plan par TCC (Transparency, Consent, Control) avec EPERM. Utilisez un chemin en dehors des repertoires proteges (ex. : `~/_PROJECT/`).

#### 7. Configurer le moteur de recherche qmd (optionnel)

Activez la recherche plein texte et semantique du Wiki via MCP.

```bash
bash scripts/setup-qmd.sh
bash scripts/install-qmd-daemon.sh
```

#### 8. Installer les competences Wiki Ingest (optionnel)

```bash
bash scripts/install-skills.sh
```

#### 9. Deployer sur des machines supplementaires

```bash
git clone git@github.com:<USERNAME>/kioku.git ~/kioku/main-kioku
# Ouvrir ~/kioku/main-kioku/ comme Vault dans Obsidian
# Repeter les etapes 2 a 6
```

<br>

## Structure des repertoires

```

├── README.md                        ← Ce fichier
├── hooks/
│   ├── session-logger.mjs           ← Point d'entree du Hook (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart : injecte wiki/index.md dans le prompt systeme
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← Commande slash d'import en masse projet-vers-Wiki
│   └── wiki-ingest/SKILL.md         ← Commande slash de scan cible
├── templates/
│   ├── vault/                       ← Fichiers racine du Vault (CLAUDE.md, .gitignore)
│   ├── notes/                       ← Templates de notes (concept, project, decision, source-summary)
│   ├── wiki/                        ← Fichiers wiki initiaux (index.md, log.md)
│   └── launchd/*.plist.template     ← Templates macOS LaunchAgent
├── scripts/
│   ├── setup-vault.sh               ← Initialisation du Vault (idempotent)
│   ├── install-hooks.sh             ← Affichage du snippet de config Hook / --apply pour fusion auto
│   ├── auto-ingest.sh               ← Planifie : ingere les logs non traites dans le wiki
│   ├── auto-lint.sh                 ← Planifie : rapport de sante du wiki + scan de secrets
│   ├── install-cron.sh              ← Affiche les entrees cron sur stdout
│   ├── install-schedule.sh          ← Dispatcher selon l'OS (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← Installeur macOS LaunchAgent
│   ├── setup-qmd.sh                 ← Enregistrement de collection qmd + indexation initiale
│   ├── install-qmd-daemon.sh        ← Serveur HTTP MCP qmd en daemon launchd
│   ├── install-skills.sh            ← Lien symbolique des competences wiki-ingest vers ~/.claude/skills/
│   └── scan-secrets.sh              ← Detection de fuites de secrets dans session-logs/
└── tests/                           ← Tests node --test et smoke tests bash
```

<br>

## Variables d'environnement

| Variable | Defaut | Objectif |
|---|---|---|
| `OBSIDIAN_VAULT` | aucun (requis) | Racine du Vault. auto-ingest/lint se rabattent sur `${HOME}/kioku/main-kioku` |
| `KIOKU_DRY_RUN` | `0` | `1` pour ignorer les appels `claude -p` (verification des chemins uniquement) |
| `KIOKU_NO_LOG` | non defini | `1` pour supprimer session-logger.mjs (empeche la journalisation recursive des sous-processus cron) |
| `KIOKU_DEBUG` | non defini | `1` pour emettre des infos de debogage sur stderr et dans `session-logs/.kioku/errors.log` |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Chemin du log d'Ingest (reference par les auto-diagnostics d'auto-lint) |

### Configuration du PATH pour les gestionnaires de versions Node

Les scripts planifies (`auto-ingest.sh`, `auto-lint.sh`) s'executent depuis cron / LaunchAgent et n'heritent pas du PATH de votre shell interactif. Ils ajoutent Volta (`~/.volta/bin`) et mise (`~/.local/share/mise/shims`) au PATH. **Si vous utilisez nvm / fnm / asdf ou un autre gestionnaire de versions**, modifiez la ligne `export PATH=...` en haut de chaque script :

```bash
# exemple nvm
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# exemple fnm
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## Notes de conception

- **Les logs de session contiennent des secrets** : Les prompts et les sorties d'outils peuvent contenir des cles API, des tokens ou des donnees personnelles. `session-logger.mjs` applique un masquage par regex avant l'ecriture
- **Perimetre d'ecriture** : Les Hooks n'ecrivent que dans `$OBSIDIAN_VAULT/session-logs/`. Ils ne touchent jamais `raw-sources/`, `wiki/` ou `templates/`
- **session-logs n'atteint jamais Git** : Exclu par `.gitignore`, minimisant le risque de push accidentel vers GitHub
- **Aucun acces reseau** : Les scripts de Hook (`session-logger.mjs`) n'importent pas `http`/`https`/`net`/`dgram`. La synchronisation Git est geree par des commandes shell dans la configuration de Hook
- **Idempotent** : `setup-vault.sh` / `install-hooks.sh` peuvent etre executes plusieurs fois sans detruire les fichiers existants
- **Pas de git init** : `setup-vault.sh` n'initialise pas de depot Git et n'ajoute pas de remotes. L'authentification GitHub est de la responsabilite de l'utilisateur

<br>

## Configuration multi-machine

kioku est concu pour **partager un seul Wiki entre plusieurs machines** via la synchronisation Git.
L'auteur utilise une configuration a deux Mac : un MacBook (machine de developpement principale) et un Mac mini (pour le mode bypass permission de Claude Code).

Points cles pour l'operation multi-machine :
- **`session-logs/` reste local sur chaque machine** (exclu par `.gitignore`). Les logs de session de chaque machine sont independants et ne sont jamais pushes vers Git
- **`wiki/` est synchronise via Git**. Les resultats d'Ingest de n'importe quelle machine s'accumulent dans le meme Wiki
- **Decalez les horaires d'execution Ingest/Lint** entre machines pour eviter les conflits de git push
- L'auto commit/push du Hook SessionEnd est active sur toutes les machines, mais les sessions de code normales n'ecrivent que dans `session-logs/` — les operations git ne se declenchent que quand `wiki/` est modifie directement

Reference : configuration a deux Mac de l'auteur

| | MacBook (principal) | Mac mini (bypass) |
|---|---|---|
| Secrets | Oui | Non |
| `session-logs/` | Local uniquement | Local uniquement |
| `wiki/` | Synchronise via Git | Synchronise via Git |
| Horaire Ingest | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Horaire Lint | 1er du mois 8:00 | 2e du mois 8:00 |
| Planificateur | LaunchAgent | LaunchAgent |

> Si vous n'utilisez qu'une seule machine, vous pouvez ignorer completement cette section. Les etapes du Demarrage rapide suffisent.

<br>

## Securite

kioku est un systeme de Hook qui accede a **toutes les E/S des sessions Claude Code**.
Consultez [SECURITY.md](SECURITY.md) pour la conception de securite complete.

### Couches de defense

| Couche | Description |
|---|---|
| **Validation des entrees** | Le chemin `OBSIDIAN_VAULT` est verifie pour les metacaracteres shell et les caracteres de controle JSON/XML |
| **Masquage** | Cles API (Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), authentification Bearer/Basic, identifiants dans les URL, cles privees PEM remplaces par `***` |
| **Permissions** | `session-logs/` cree avec `0o700`, fichiers de log avec `0o600`. Les scripts de Hook sont definis a `chmod 755` |
| **Garde .gitignore** | Verifie que `.gitignore` contient `session-logs/` avant chaque git commit |
| **Prevention de la recursion** | `KIOKU_NO_LOG=1` + verification cwd-dans-vault (double garde) empeche la journalisation recursive des sous-processus |
| **Restriction des permissions LLM** | auto-ingest / auto-lint executent `claude -p` avec `--allowedTools Write,Read,Edit` (pas de Bash) |
| **Scan periodique** | `scan-secrets.sh` analyse session-logs/ mensuellement pour les patrons de tokens connus afin de detecter les echecs de masquage |

### Ajouter des patrons de tokens

Lorsque vous commencez a utiliser un nouveau service cloud, ajoutez son patron de token a la fois dans `hooks/session-logger.mjs` (`MASK_RULES`) et dans `scripts/scan-secrets.sh` (`PATTERNS`).

### Signaler des vulnerabilites

Si vous trouvez un probleme de securite, veuillez le signaler via [SECURITY.md](SECURITY.md) — pas via les Issues publiques.

<br>

## Feuille de route

### Court terme
- [ ] **Ajustement de la qualite d'Ingest** — Revoir et ajuster les criteres de selection dans le Vault CLAUDE.md apres 2 semaines d'executions reelles d'Ingest
- [ ] **Recherche multilingue qmd** — Verifier la precision de la recherche semantique pour le contenu non anglais ; changer le modele d'embeddings si necessaire (ex., `multilingual-e5-small`)
- [ ] **Competence d'auto-correction securisee (`/wiki-fix-safe`)** — Auto-corriger les problemes Lint triviaux (ajouter les liens croises manquants, combler les lacunes de frontmatter) avec approbation humaine
- [ ] **Visibilite des erreurs de synchronisation Git** — Enregistrer les echecs `git push` dans `session-logs/.kioku/git-sync.log` et afficher des avertissements dans auto-ingest

### Moyen terme
- [ ] **Support multi-LLM** — Remplacer `claude -p` dans auto-ingest/lint par un backend LLM connectable (API OpenAI, modeles locaux via Ollama, etc.)
- [ ] **CI/CD** — GitHub Actions pour les tests automatises a chaque push
- [ ] **Notifications de diff Lint** — Afficher uniquement les problemes *nouvellement detectes* en comparant avec le rapport lint precedent
- [ ] **Verrouillage optimiste pour index.json** — Empecher les mises a jour perdues lorsque plusieurs sessions Claude Code s'executent en parallele

### Long terme
- [ ] **Briefing matinal** — Generer automatiquement un resume quotidien (sessions d'hier, decisions en suspens, nouvelles idees) sous forme de `wiki/daily/YYYY-MM-DD.md`
- [ ] **Injection de contexte par projet** — Filtrer `wiki/index.md` par le projet en cours (base sur `cwd`) pour rester dans la limite de 10 000 caracteres
- [ ] **Competence de recommandation de stack (`/wiki-suggest-stack`)** — Suggerer des stacks technologiques pour les nouveaux projets bases sur les connaissances Wiki accumulees
- [ ] **Wiki d'equipe** — Partage de Wiki multi-personnes (les session-logs de chaque membre restent locaux ; seul wiki/ est partage via Git)

> **Note** : KIOKU necessite actuellement **Claude Code (plan Max)**. Le systeme de Hook (L0) et l'injection de contexte Wiki sont specifiques a Claude Code. Le pipeline Ingest/Lint (L1/L2) peut fonctionner avec d'autres API LLM en remplacant l'appel `claude -p` — ceci est prevu comme une amelioration future.

<br>

## Licence

Ce projet est sous licence MIT. Consultez [LICENSE](LICENSE) pour les details.

Comme indique dans la section « Notes importantes » ci-dessus, ce logiciel est fourni « tel quel » sans garantie d'aucune sorte.

<br>

## References

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — Le concept original que ce projet implemente
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — Documentation officielle du systeme de Hooks
- [Obsidian](https://obsidian.md/) — L'application de gestion des connaissances utilisee comme visionneuse du Wiki
- [qmd](https://github.com/tobi/qmd) — Moteur de recherche local pour Markdown (BM25 + recherche vectorielle)

<br>


## Other Products

[hello from the seasons.](https://hello-from.dokokano.photo/en)

<br>

## Auteur

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

Je construis des choses avec du code et de l'IA. Ingenieur freelance, 10 ans d'experience. Specialise en frontend, mon flux de travail principal est desormais le co-developpement avec Claude.

[Suivez-moi sur X](https://x.com/megaphone_tokyo) [![Follow @megaphone_tokyo](https://img.shields.io/twitter/follow/megaphone_tokyo?style=social)](https://x.com/megaphone_tokyo)
