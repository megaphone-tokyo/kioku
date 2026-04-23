## 이 매뉴얼은 여러 언어로 제공됩니다

> [!NOTE]
> **🌐 다른 언어:** [🇬🇧 English](README.md) · [🇯🇵 日本語](README.ja.md) · [🇹🇼 繁體中文](README.zh-TW.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇮🇳 हिन्दी](README.hi.md) · [🇪🇸 Español](README.es.md) · [🇧🇷 Português](README.pt-BR.md) · 🇰🇷 **한국어** · [🇫🇷 Français](README.fr.md) · [🇷🇺 Русский](README.ru.md)

<br>

# KIOKU
### Memory for Claude Code

<sub>*KIOKU means "memory" in Japanese*</sub>

Claude Code는 세션이 끝나면 과거의 지식을 잊어버립니다.
claude-brain은 **대화를 자동으로 Wiki에 축적**하고 **다음 세션에서 이를 기억**합니다.

같은 설명을 반복할 필요가 없습니다. 매번 사용할 때마다 성장하는 "세컨드 브레인" — 당신의 Claude를 위해.

<br>

## 주요 기능

Claude Code 세션을 자동으로 기록하고, Obsidian Vault 위에 구조화된 지식 베이스를 구축합니다. Andrej Karpathy의 LLM Wiki 패턴과 자동 로깅 및 여러 머신 간 Git 동기화를 결합했습니다.

```
🗣️  평소처럼 Claude Code와 대화합니다
         ↓  （모든 것이 자동으로 기록됩니다 — 아무것도 할 필요 없습니다）
📝  세션 로그가 로컬에 저장됩니다
         ↓  （스케줄된 작업이 AI에게 로그를 읽고 지식을 추출하게 합니다）
📚  Wiki가 매 세션마다 성장합니다 — 개념, 결정, 패턴
         ↓  （Git으로 동기화）
☁️  GitHub이 Wiki를 백업하고 여러 머신 간에 공유합니다
```

1. **자동 캡처 (L0)**: Claude Code Hook 이벤트(`UserPromptSubmit` / `Stop` / `PostToolUse` / `SessionEnd`)를 포착하여 `session-logs/`에 Markdown으로 기록
2. **구조화 (L1)**: 예약 실행(macOS LaunchAgent / Linux cron)을 통해 LLM이 미처리 로그를 읽고 `wiki/`에 개념 페이지, 프로젝트 페이지, 설계 결정을 작성. 세션 인사이트는 `wiki/analyses/`에도 저장
3. **무결성 검사 (L2)**: 월간 Wiki 상태 점검으로 `wiki/lint-report.md`를 생성. 비밀 정보 유출 자동 탐지 포함
4. **동기화 (L3)**: Vault 자체가 Git 리포지토리. `SessionStart`에서 `git pull`, `SessionEnd`에서 `git commit && git push`를 실행하여 GitHub Private 리포지토리를 통해 머신 간 동기화
5. **Wiki 컨텍스트 주입**: `SessionStart` 시 `wiki/index.md`를 시스템 프롬프트에 주입하여 Claude가 과거 지식을 활용할 수 있도록 지원
6. **qmd 전문 검색**: MCP를 통해 BM25 + 시맨틱 검색으로 Wiki 검색
7. **Wiki Ingest 스킬**: `/wiki-ingest-all` 및 `/wiki-ingest` 슬래시 커맨드로 기존 프로젝트 지식을 Wiki에 가져오기
8. **비밀 정보 격리**: `session-logs/`는 머신별 로컬 유지(`.gitignore`). `wiki/` / `raw-sources/` / `templates/` / `CLAUDE.md`만 Git으로 관리

<br>

## 주의사항

> [!CAUTION]
> claude-brain은 현재 **Claude Code (Max 플랜)**이 필요합니다. Hook 시스템(L0)과 Wiki 컨텍스트 주입은 Claude Code 전용 기능입니다. Ingest/Lint 파이프라인(L1/L2)은 `claude -p` 호출을 교체하면 다른 LLM API와 함께 사용할 수 있습니다 -- 이는 향후 개선으로 계획되어 있습니다.

> [!IMPORTANT]
> 이 소프트웨어는 어떠한 종류의 보증도 없이 **"있는 그대로"** 제공됩니다. 저자는 이 도구의 사용으로 인해 발생하는 데이터 손실, 보안 사고 또는 손해에 대해 **어떠한 책임도 지지 않습니다**. 사용에 따른 위험은 본인이 부담합니다. 전체 약관은 [LICENSE](../../LICENSE)를 참조하세요.

<br>

## 사전 요구 사항

| | 버전 / 요구 사항 |
|---|---|
| macOS | 13+ 권장 |
| Node.js | 18+ (Hook 스크립트는 `.mjs` ES Module, 외부 의존성 없음) |
| Bash | 3.2+ (macOS 기본) |
| Git | 2.x+. `git pull --rebase` / `git push` 지원 필수 |
| GitHub CLI | 선택 사항 (`gh`로 Private 리포 생성 간소화) |
| Claude Code | **Max 플랜** 필수 (`claude` CLI와 `~/.claude/settings.json`의 Hook 시스템 사용) |
| Obsidian | 임의 폴더에 Vault 하나 생성 (iCloud Drive 불필요) |
| jq | 1.6+ (`install-hooks.sh --apply`에서 사용) |
| 환경 변수 | `OBSIDIAN_VAULT`가 Vault 루트를 가리키도록 설정 |

<br>

## 빠른 시작

> [!WARNING]
> **설치 전에 이해하세요:** claude-brain은 **모든 Claude Code 세션 I/O**에 hook됩니다. 이는 다음을 의미합니다:
> - 세션 로그에는 프롬프트와 도구 출력의 **API 키, 토큰 또는 개인 정보**가 포함될 수 있습니다. 마스킹은 주요 패턴을 커버하지만 완전하지는 않습니다 -- [SECURITY.md](SECURITY.md)를 참조하세요
> - `.gitignore`가 잘못 설정되면 세션 로그가 **실수로 GitHub에 푸시**될 수 있습니다
> - 자동 Ingest 파이프라인은 Wiki 추출을 위해 `claude -p`를 통해 세션 로그 내용을 Claude에 전송합니다
>
> 전체 운영을 활성화하기 전에 `KIOKU_DRY_RUN=1`로 파이프라인을 먼저 확인하는 것을 권장합니다.

### 🚀 인터랙티브 설정 (권장)

> [!NOTE]
> Claude Code에서 다음을 입력하면 인터랙티브 가이드 설정이 시작됩니다. 각 단계의 목적을 설명하고 환경에 맞게 조정합니다.

```
Please read tools/claude-brain/skills/setup-guide/SKILL.md and guide me through the claude-brain installation.
```

### 🛠️ 수동 설정

> [!NOTE]
> 각 단계를 직접 이해하고 싶은 분을 위한 방법입니다. 스크립트를 직접 실행하세요.

#### 1. Vault를 만들고 Git 리포지토리에 연결 (수동)

1. Obsidian에서 새 Vault 생성 (예: `~/claude-brain/main-claude-brain`)
2. GitHub에 Private 리포지토리 생성 (예: `claude-brain`)
3. Vault 디렉터리에서: `git init && git remote add origin ...` (또는 `gh repo create --private --source=. --push`)

이 단계는 claude-brain 스크립트로 자동화되지 않습니다. GitHub 인증(gh CLI / SSH 키)은 사용자 환경에 따라 다릅니다.

#### 2. 환경 변수 설정

```bash
# ~/.zshrc 또는 ~/.bashrc에 추가
export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"
```

#### 3. Vault 초기화

```bash
# Vault 하위에 raw-sources/, session-logs/, wiki/, templates/를 생성하고
# CLAUDE.md / .gitignore / 초기 템플릿을 배치 (기존 파일은 절대 덮어쓰지 않음)
bash tools/claude-brain/scripts/setup-vault.sh
```

#### 4. Hook 설치

```bash
# 옵션 A: 자동 병합 (권장, jq 필요)
bash tools/claude-brain/scripts/install-hooks.sh --apply
# 백업 생성 → diff 표시 → 확인 프롬프트 → 기존 설정을 유지하면서 Hook 항목 추가

# 옵션 B: 수동 병합
bash tools/claude-brain/scripts/install-hooks.sh
# JSON 스니펫을 stdout에 출력하여 ~/.claude/settings.json에 수동으로 병합
```

#### 5. 확인

Claude Code를 재시작한 뒤, 대화를 한 번 진행합니다.
`$OBSIDIAN_VAULT/session-logs/YYYYMMDD-HHMMSS-<id>-<prompt>.md`가 생성되어야 합니다.

> **1~5단계는 필수입니다.** 이후 단계는 선택 사항이지만 전체 기능을 위해 권장됩니다.

#### 6. 예약 실행 설정 (권장)

자동 Ingest(매일)와 Lint(매월)를 설정합니다.

```bash
# OS 자동 감지: macOS → LaunchAgent, Linux → cron
bash tools/claude-brain/scripts/install-schedule.sh

# 먼저 DRY RUN으로 테스트
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-ingest.sh
KIOKU_DRY_RUN=1 bash tools/claude-brain/scripts/auto-lint.sh
```

> **macOS 참고**: 리포를 `~/Documents/`나 `~/Desktop/` 아래에 두면 TCC(Transparency, Consent, Control)가 백그라운드 접근을 EPERM으로 차단할 수 있습니다. 보호된 디렉터리 밖의 경로(예: `~/_PROJECT/`)를 사용하세요.

#### 7. qmd 검색 엔진 설정 (선택 사항)

Wiki에 대한 MCP 기반 전문 검색 및 시맨틱 검색을 활성화합니다.

```bash
bash tools/claude-brain/scripts/setup-qmd.sh
bash tools/claude-brain/scripts/install-qmd-daemon.sh
```

#### 8. Wiki Ingest 스킬 설치 (선택 사항)

```bash
bash tools/claude-brain/scripts/install-skills.sh
```

#### 9. 추가 머신에 배포

```bash
git clone git@github.com:<USERNAME>/claude-brain.git ~/claude-brain/main-claude-brain
# ~/claude-brain/main-claude-brain/을 Obsidian에서 Vault로 열기
# 2~6단계를 반복
```

<br>

## 디렉터리 구조

```
tools/claude-brain/
├── README.md                        ← 이 파일
├── context/                         ← 현재 구현 (INDEX + 기능별 문서)
├── handoff/                         ← 다음 세션을 위한 인수인계 노트
├── plan/
│   ├── user/                      ← 사용자의 설계 지시서
│   └── claude/                      ← Claude의 구현 사양
├── hooks/
│   ├── session-logger.mjs           ← Hook 진입점 (UserPromptSubmit/Stop/PostToolUse/SessionEnd)
│   └── wiki-context-injector.mjs    ← SessionStart: wiki/index.md를 시스템 프롬프트에 주입
├── skills/
│   ├── wiki-ingest-all/SKILL.md     ← 프로젝트 → Wiki 일괄 가져오기 슬래시 커맨드
│   └── wiki-ingest/SKILL.md         ← 대상 지정 스캔 슬래시 커맨드
├── templates/
│   ├── vault/                       ← Vault 루트 파일 (CLAUDE.md, .gitignore)
│   ├── notes/                       ← 노트 템플릿 (concept, project, decision, source-summary)
│   ├── wiki/                        ← 초기 Wiki 파일 (index.md, log.md)
│   └── launchd/*.plist.template     ← macOS LaunchAgent 템플릿
├── scripts/
│   ├── setup-vault.sh               ← Vault 초기화 (멱등성)
│   ├── install-hooks.sh             ← Hook 설정 스니펫 출력 / --apply로 자동 병합
│   ├── auto-ingest.sh               ← 예약: 미처리 로그를 Wiki에 통합
│   ├── auto-lint.sh                 ← 예약: Wiki 상태 보고서 + 비밀 정보 스캔
│   ├── install-cron.sh              ← cron 항목을 stdout에 출력
│   ├── install-schedule.sh          ← OS 인식 디스패처 (macOS → LaunchAgent / Linux → cron)
│   ├── install-launchagents.sh      ← macOS LaunchAgent 설치
│   ├── setup-qmd.sh                 ← qmd 컬렉션 등록 + 초기 인덱싱
│   ├── install-qmd-daemon.sh        ← qmd MCP HTTP 서버를 launchd 데몬으로 설치
│   ├── install-skills.sh            ← wiki-ingest 스킬을 ~/.claude/skills/에 심볼릭 링크
│   └── scan-secrets.sh              ← session-logs/의 비밀 정보 유출 탐지
└── tests/                           ← node --test 및 bash 스모크 테스트
```

<br>

## 환경 변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `OBSIDIAN_VAULT` | 없음 (필수) | Vault 루트. auto-ingest/lint는 `${HOME}/claude-brain/main-claude-brain`으로 폴백 |
| `KIOKU_DRY_RUN` | `0` | `1`로 설정 시 `claude -p` 호출을 건너뜀 (경로 확인만 수행) |
| `KIOKU_NO_LOG` | 미설정 | `1`로 설정 시 session-logger.mjs를 비활성화 (cron 하위 프로세스의 재귀 로깅 방지) |
| `KIOKU_DEBUG` | 미설정 | `1`로 설정 시 stderr와 `session-logs/.claude-brain/errors.log`에 디버그 정보 출력 |
| `KIOKU_INGEST_LOG` | `$HOME/kioku-ingest.log` | Ingest 로그 출력 경로 (auto-lint 자가 진단에서 참조) |

### Node 버전 관리자 PATH 설정

예약 스크립트(`auto-ingest.sh`, `auto-lint.sh`)는 cron / LaunchAgent에서 실행되므로 대화형 셸의 PATH를 상속받지 않습니다. 기본적으로 Volta(`~/.volta/bin`)와 mise(`~/.local/share/mise/shims`)를 PATH에 추가합니다. **nvm / fnm / asdf 또는 다른 버전 관리자를 사용하는 경우**, 각 스크립트 상단의 `export PATH=...` 줄을 수정하세요:

```bash
# nvm 예시
export PATH="${HOME}/.nvm/versions/node/v22.0.0/bin:${PATH}"

# fnm 예시
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${PATH}"
```

<br>

## 설계 참고 사항

- **세션 로그에는 비밀 정보가 포함될 수 있습니다**: 프롬프트와 도구 출력에 API 키, 토큰, 개인 정보가 포함될 수 있습니다. `session-logger.mjs`는 기록 전에 정규식 마스킹을 적용합니다
- **쓰기 범위**: Hook은 `$OBSIDIAN_VAULT/session-logs/`에만 기록합니다. `raw-sources/`, `wiki/`, `templates/`에는 절대 접근하지 않습니다
- **session-logs는 Git에 올라가지 않습니다**: `.gitignore`로 제외되어 GitHub로의 실수 푸시 위험을 최소화합니다
- **네트워크 접근 없음**: Hook 스크립트(`session-logger.mjs`)는 `http`/`https`/`net`/`dgram`을 import하지 않습니다. Git 동기화는 Hook 설정의 셸 원라이너로 처리됩니다
- **멱등성**: `setup-vault.sh` / `install-hooks.sh`는 기존 파일을 파괴하지 않고 여러 번 실행할 수 있습니다
- **git init 없음**: `setup-vault.sh`는 Git 리포지토리를 초기화하거나 리모트를 추가하지 않습니다. GitHub 인증은 사용자가 직접 설정해야 합니다

<br>

## 멀티 머신 설정

claude-brain은 Git 동기화를 통해 **여러 머신에서 하나의 Wiki를 공유**하도록 설계되었습니다.
저자는 두 대의 Mac 설정을 사용합니다: MacBook(주 개발 머신)과 Mac mini(Claude Code bypass permission 모드용).

멀티 머신 운영의 핵심 사항:
- **`session-logs/`는 각 머신에 로컬로 유지**됩니다(`.gitignore`로 제외). 각 머신의 세션 로그는 독립적이며 Git에 푸시되지 않습니다
- **`wiki/`는 Git으로 동기화**됩니다. 어떤 머신의 Ingest 결과든 동일한 Wiki에 축적됩니다
- **머신 간 Ingest/Lint 실행 시간을 분산**하여 git push 충돌을 방지하세요
- SessionEnd Hook의 자동 commit/push는 모든 머신에서 활성화되지만, 일반 코딩 세션은 `session-logs/`에만 기록합니다 -- git 작업은 `wiki/`가 직접 수정될 때만 트리거됩니다

참조: 저자의 두 대 Mac 구성

| | MacBook (주력) | Mac mini (bypass) |
|---|---|---|
| 비밀 정보 | 있음 | 없음 |
| `session-logs/` | 로컬 전용 | 로컬 전용 |
| `wiki/` | Git 동기화 | Git 동기화 |
| Ingest 스케줄 | 7:00 / 13:00 / 19:00 | 7:30 / 13:30 / 19:30 |
| Lint 스케줄 | 매월 1일 8:00 | 매월 2일 8:00 |
| 스케줄러 | LaunchAgent | LaunchAgent |

> 단일 머신에서 실행하는 경우 이 섹션을 완전히 무시해도 됩니다. 빠른 시작 단계만으로 충분합니다.

<br>

## 보안

claude-brain은 **모든 Claude Code 세션 입출력**에 접근하는 Hook 시스템입니다.
전체 보안 설계는 [SECURITY.md](SECURITY.md)를 참조하세요.

### 방어 계층

| 계층 | 설명 |
|---|---|
| **입력 검증** | `OBSIDIAN_VAULT` 경로에서 셸 메타 문자 및 JSON/XML 제어 문자를 검사 |
| **마스킹** | API 키(Anthropic / OpenAI / GitHub / AWS / Slack / Vercel / npm / Stripe / Supabase / Firebase / Azure), Bearer/Basic 인증, URL 자격 증명, PEM 개인 키를 `***`로 치환 |
| **권한** | `session-logs/`는 `0o700`, 로그 파일은 `0o600`으로 생성. Hook 스크립트는 `chmod 755`로 설정 |
| **.gitignore 가드** | 매 git commit 전에 `.gitignore`에 `session-logs/`가 포함되어 있는지 확인 |
| **재귀 방지** | `KIOKU_NO_LOG=1` + cwd-in-vault 검사(이중 가드)로 하위 프로세스의 재귀 로깅 방지 |
| **LLM 권한 제한** | auto-ingest / auto-lint는 `claude -p`를 `--allowedTools Write,Read,Edit`로 실행 (Bash 없음) |
| **주기적 스캔** | `scan-secrets.sh`가 매월 session-logs/에서 알려진 토큰 패턴을 스캔하여 마스킹 실패 감지 |

### 토큰 패턴 추가

새로운 클라우드 서비스를 사용하기 시작하면 해당 토큰 패턴을 `hooks/session-logger.mjs`(`MASK_RULES`)와 `scripts/scan-secrets.sh`(`PATTERNS`) 양쪽에 추가하세요.

### 취약점 보고

보안 문제를 발견하면 공개 Issue가 아닌 [SECURITY.md](SECURITY.md)를 통해 보고해 주세요.

<br>

## 로드맵

### 단기
- [ ] **Ingest 품질 튜닝** — 2주간의 실제 Ingest 실행 후 Vault CLAUDE.md의 선별 기준 검토 및 조정
- [ ] **qmd 다국어 검색** — 비영어 콘텐츠에 대한 시맨틱 검색 정확도 검증; 필요시 임베딩 모델 교체 (예: `multilingual-e5-small`)
- [ ] **안전한 자동 수정 스킬 (`/wiki-fix-safe`)** — 사람의 승인을 받아 사소한 Lint 이슈 자동 수정 (누락된 교차 링크 추가, frontmatter 공백 채우기)
- [ ] **Git 동기화 오류 가시성** — `git push` 실패를 `session-logs/.claude-brain/git-sync.log`에 기록하고 auto-ingest에서 경고 표시

### 중기
- [ ] **멀티 LLM 지원** — auto-ingest/lint의 `claude -p`를 플러거블 LLM 백엔드로 교체 (OpenAI API, Ollama를 통한 로컬 모델 등)
- [ ] **CI/CD** — 푸시 시 GitHub Actions를 통한 자동 테스트
- [ ] **Lint diff 알림** — 이전 lint 보고서와 비교하여 *새로 감지된* 이슈만 표시
- [ ] **index.json 낙관적 잠금** — 여러 Claude Code 세션이 병렬 실행될 때 업데이트 손실 방지

### 장기
- [ ] **모닝 브리핑** — 일일 요약 자동 생성 (어제의 세션, 미결 결정, 새로운 인사이트) `wiki/daily/YYYY-MM-DD.md`로
- [ ] **프로젝트 인식 컨텍스트 주입** — 현재 프로젝트(`cwd` 기반)에 따라 `wiki/index.md`를 필터링하여 10,000자 제한 내 유지
- [ ] **스택 추천 스킬 (`/wiki-suggest-stack`)** — 축적된 Wiki 지식을 기반으로 새 프로젝트의 기술 스택 제안
- [ ] **팀 Wiki** — 다인 Wiki 공유 (각 멤버의 session-logs는 로컬 유지; wiki/만 Git으로 공유)

> **참고**: claude-brain은 현재 **Claude Code (Max 플랜)**이 필요합니다. Hook 시스템(L0)과 Wiki 컨텍스트 주입은 Claude Code 전용입니다. Ingest/Lint 파이프라인(L1/L2)은 `claude -p` 호출을 교체하면 다른 LLM API와 함께 사용할 수 있습니다 -- 이는 향후 개선으로 계획되어 있습니다.

<br>

## 변경 이력

### 2026-04-23 — v0.5.0: 기능 2.4 — PDF / MD / EPUB / DOCX 통합 ingest router

- **Phase 1** — `kioku_ingest_document` router 추가. 확장자(`.pdf` / `.md` / `.epub` / `.docx`)에 따라 적절한 handler로 dispatch하는 통합 MCP tool. 기존 `kioku_ingest_pdf`는 deprecation alias로 v0.5 ~ v0.7 window 동안 유지되며, v0.8에서 제거 예정
- **Phase 2** — EPUB 취입: yauzl 기반의 8 층 방어(zip-slip / symlink / 누적 size cap / entry count cap / NFKC filename / nested ZIP skip / XXE pre-scan / XHTML script sanitize)로 안전하게 전개. spine 순의 챕터를 `readability-extract` + `turndown`으로 Markdown chunk화하여 `.cache/extracted/epub-<subdir>--<stem>-ch<NNN>.md`에 저장 (2 챕터 이상인 경우 `-index.md`도 생성). LLM 요약은 auto-ingest cron으로 비동기 처리
- **Phase 3** — DOCX 취입 (MVP): `mammoth + yauzl` 2 단 구성 (mammoth 내부 jszip의 attack surface를 yauzl 측 8 층 방어로 사전 차단). `word/document.xml` / `docProps/core.xml`은 XXE pre-scan(`assertNoDoctype`) 경유. 이미지(VULN-D004/D007)와 OLE 임베딩(VULN-D006)은 defer, MVP에서는 본문 + 제목만 추출. Metadata는 `--- DOCX METADATA ---` fence + **untrusted** 주석으로 다운스트림 LLM 요약에 대한 prompt injection을 delimit
- **Pre-release hotfix** — `scripts/extract-docx.mjs` / `scripts/extract-epub.mjs`의 argv 정규표현식을 Unicode-aware(`\p{L}\p{N}`)로 수정. 기존 `\w` (ASCII 전용)에서는 `論文.docx` / `日本語.epub` 같은 일본어/중국어 파일명이 auto-ingest cron 경로에서 silent skip되고 있었음. EPUB은 v0.4.0 이후의 latent regression을 소급 수정(LEARN#6 cross-boundary drift). 아울러 `html-sanitize`의 `DANGEROUS_TAGS`에 `meta` / `base` / `link`를 추가(향후 EPUB consumer 경로용 defense-in-depth)
- **기지 issue (비적용)** — `fast-xml-parser` CVE-2026-41650 ([GHSA-gh4j-gqv2-49f6](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-gh4j-gqv2-49f6), medium)은 **XMLBuilder** (XML을 쓰는 API) 고유의 문제. 본 프로젝트는 `mcp/lib/xml-safe.mjs`에서 **XMLParser만** (XML을 읽는 API) 사용하므로 exploit 불가. dependabot alert 해소를 위해 **v0.5.1**에서 `fast-xml-parser@^5.7.0`으로 upgrade 예정
- 테스트: **Bash 158 assertions + Node 전 suite green** (extract-docx 16 / extract-epub 7 / html-sanitize 10 / auto-ingest 70 / cron-guard-parity 25 / MCP layer 30). `npm audit`은 runtime deps에서 **0 vulnerabilities**, red-hacker + blue-hacker 병렬 `/security-review`에서 **HIGH/CRITICAL 0** 건
- [Release v0.5.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.5.0) — `kioku-wiki-0.5.0.mcpb` 첨부 (9.2 MB)

### 2026-04-21 — v0.4.0: Tier A (보안 + 운영) + Tier B (정합성) 개편

- **A#1** — `@mozilla/readability` 0.5 → 0.6으로 업그레이드 (ReDoS [GHSA-3p6v-hrg8-8qj7](https://github.com/advisories/GHSA-3p6v-hrg8-8qj7) 완화; 144개의 프로덕션 의존성이 `npm audit` 클린 통과)
- **A#2** — `auto-ingest.sh` / `auto-lint.sh` / `install-hooks.sh` SessionEnd에 `git symbolic-ref -q HEAD` 가드를 추가하여, Vault가 detached-HEAD 상태일 때 폭주 커밋이 발생하는 것을 방지 (수정 전 한 머신에서 5일간의 드리프트 관찰됨)
- **A#3** — `withLock`을 리팩터링 (holding time을 분 단위에서 초 단위로 단축)하고 `skipLock` API를 완전히 제거, orphan-PDF cleanup 추가
- **B#1** — Hook 레이어 재감사 (`session-logger.mjs`): 3건의 MEDIUM 이슈 수정 (마스킹을 우회하는 invisible-character, frontmatter의 YAML injection, `KIOKU_NO_LOG` strict-equality 드리프트)
- **B#2** — cron/setup 가드 패리티를 `tests/cron-guard-parity.test.sh` (17 assertions)로 공식화하여 Category-A / Category-B env-override 컨벤션을 강제
- **B#3** — `sync-to-app.sh`의 머신 간 race를 `check_github_side_lock` (α 가드, 기본 120초 윈도우, `KIOKU_SYNC_LOCK_MAX_AGE`로 설정 가능)으로 방지; `tests/sync-to-app.test.sh` (11 assertions)로 회귀 방지 고정
- **B#8** — README i18n 패리티: §10 MCP / §11 MCPB / Changelog 섹션을 en/ja 이외의 8개 README에 추가 (+1384 lines)
- 테스트: **299 Node 테스트** + **15 Bash 스위트 / 415 assertions**, 모두 그린
- [Release v0.4.0](https://github.com/megaphone-tokyo/kioku/releases/tag/v0.4.0) — `.mcpb` 첨부

### 2026-04-17 — Phase N: Claude Desktop용 MCPB 번들
- 새로운 `mcp/manifest.json` (MCPB v0.4)과 `scripts/build-mcpb.sh`가 `mcp/dist/kioku-wiki-<version>.mcpb` (~3.2 MB)를 생성
- Claude Desktop 사용자는 `.mcpb` 파일 하나를 드래그 앤 드롭하여 MCP 서버를 설치할 수 있습니다. `OBSIDIAN_VAULT`는 설치 다이얼로그의 디렉터리 picker로 설정 (사용자 머신에 Node 설치 불필요 — Desktop에 내장된 런타임 사용)
- 자세한 설치 방법은 [README.md](README.md) 또는 [README.ja.md](README.ja.md) 참조

### 2026-04-17 — Phase M: kioku-wiki MCP 서버
- 로컬 stdio MCP 서버 (`tools/claude-brain/mcp/`)가 6개의 도구를 제공 — `kioku_search`, `kioku_read`, `kioku_list`, `kioku_write_note`, `kioku_write_wiki`, `kioku_delete`
- Claude Desktop과 Claude Code 모두 채팅을 떠나지 않고 Wiki를 검색·열람·편집 가능
- 설정 방법은 [README.md](README.md) 또는 [README.ja.md](README.ja.md) 참조

### 2026-04-16 — Phase L: macOS LaunchAgent로 마이그레이션
- 새 디스패처 `scripts/install-schedule.sh`가 macOS LaunchAgent / Linux cron을 OS 자동 감지로 배치

<br>

## 라이선스

이 프로젝트는 MIT 라이선스로 제공됩니다. 자세한 내용은 [LICENSE](../../LICENSE)를 참조하세요.

위의 "주의사항" 섹션에 명시된 바와 같이, 이 소프트웨어는 어떠한 종류의 보증도 없이 "있는 그대로" 제공됩니다.

<br>

## 참고

- [Karpathy's LLM Wiki Gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — 이 프로젝트가 구현한 원본 개념
- [Claude Code Hooks Reference](https://docs.claude.com/en/docs/claude-code/hooks) — 공식 Hook 시스템 문서
- [Obsidian](https://obsidian.md/) — Wiki 뷰어로 사용되는 지식 관리 앱
- [qmd](https://github.com/tobi/qmd) — Markdown용 로컬 검색 엔진 (BM25 + 벡터 검색)

<br>

## 저자

**[@megaphone_tokyo](https://x.com/megaphone_tokyo)**

코드와 AI로 다양한 것을 만들고 있습니다. 프리랜스 엔지니어, 경력 10년. 프론트엔드 중심으로, 최근에는 Claude와의 공동 개발이 주요 워크플로우입니다.

[팔로우하기](https://x.com/megaphone_tokyo)
