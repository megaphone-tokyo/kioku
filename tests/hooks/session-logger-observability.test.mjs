// session-logger-observability.test.mjs — v0.11 S6-4 hooks silent failure
// observability 3 layer のユニット/統合テスト
//
// 実行: node --test tools/claude-brain/tests/hooks/session-logger-observability.test.mjs
//
// 対象 (5 系統 + parity):
//   - OBS-CORE-1   : assistant_stop 空 assistantTexts → errors.log に WARN (Layer 1)
//   - OBS-CORE-2   : writeErrorLog は masking SSOT (maskText) を経由 (G-1、二次漏洩遮断)
//   - OBS-CORE-3   : resolveTranscriptWindow (F-hooks-06 TOCTOU 縮小検出の純関数)
//   - OBS-ADPT-1..3: 3 adapter converter の rejection reason (KIOKU_DEBUG gate、
//                    reason code のみ / payload 値は出さない canary 検査込み)
//   - OBS-INJ-1..4 : SessionStart hook health 通知 (Layer 3、LEARN#9 schema 準拠)
//   - OBS-PARITY-1 : doctor.sh (Layer 2) と injector (Layer 3) の default 値 parity
//
// 原則 (testing.md):
//   - 実 Vault を触らない (mktemp -d + 終了時 rm)
//   - ネットワークなし
//   - session_id は test-session-* 固定プレフィックス
//   - fixture は synthetic のみ (実セッションログ raw 流用禁止)
//
// Test ID 採番根拠: 本 file は新規のため per-file scope で 1 起番 (LEARN#8a)。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ingestNormalizedEvent,
  resolveTranscriptWindow,
  writeErrorLog,
} from '../../hooks/session-logger-core.mjs';
import { claudePayloadToNormalizedEvent } from '../../hooks/adapters/claude.mjs';
import { geminiPayloadToNormalizedEvent } from '../../hooks/adapters/gemini.mjs';
import { codexPayloadToNormalizedEvent } from '../../hooks/adapters/codex.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CB_ROOT = join(__dirname, '..', '..');
const INJECTOR_PATH = join(CB_ROOT, 'hooks', 'wiki-context-injector.mjs');
const DOCTOR_PATH = join(CB_ROOT, 'scripts', 'doctor.sh');
const INJECTOR_SRC_PATH = INJECTOR_PATH;

// -----------------------------------------------------------------------------
// ヘルパ
// -----------------------------------------------------------------------------

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'claude-brain-obs-test-'));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
  return { root, vault };
}

function buildCtx(vault) {
  const sessionLogsDir = join(vault, 'session-logs');
  const internalDir = join(sessionLogsDir, '.claude-brain');
  return {
    vault,
    sessionLogsDir,
    internalDir,
    indexPath: join(internalDir, 'index.json'),
  };
}

async function readErrorsLog(ctx) {
  try {
    return await readFile(join(ctx.internalDir, 'errors.log'), 'utf8');
  } catch {
    return '';
  }
}

// process.stderr.write を一時差し替えて同期 fn の stderr 出力を捕捉する
// (converter は同期関数、entry gate により import では stdin を読まない)
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

// synthetic errors.log を生成 (実セッションログ raw は使わない)
async function makeErrorsLog(vault, { warnLines = 0, extraLines = [] } = {}) {
  const internalDir = join(vault, 'session-logs', '.claude-brain');
  await mkdir(internalDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < warnLines; i++) {
    lines.push(
      `[2026-07-09T00:00:00.000Z] WARN: assistant_stop yielded no text (schema drift / thinking-only / corrupted transcript) session=test-session-obs${i} consumedLines=1`,
    );
  }
  lines.push(...extraLines);
  await writeFile(join(internalDir, 'errors.log'), lines.join('\n') + '\n', 'utf8');
}

function runInjector({ vault, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    // host env の KIOKU_HOOK_WARN_* / KIOKU_DEBUG が test の期待 (default 値
    // 挙動) を汚染しないよう明示的に落としてから extraEnv を適用する
    const env = { ...process.env, OBSIDIAN_VAULT: vault };
    delete env.KIOKU_HOOK_WARN_WINDOW;
    delete env.KIOKU_HOOK_WARN_THRESHOLD;
    delete env.KIOKU_DEBUG;
    Object.assign(env, extraEnv);
    const child = spawn('node', [INJECTOR_PATH], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function userPromptEvent(sessionId) {
  return {
    sessionId,
    eventName: 'user_prompt',
    agent: 'claude',
    timestamp: new Date(),
    userPrompt: { text: 'observability test prompt' },
    cwd: '/tmp',
  };
}

function assistantStopEvent(sessionId, transcriptPath) {
  return {
    sessionId,
    eventName: 'assistant_stop',
    agent: 'claude',
    timestamp: new Date(),
    assistantResponse: { transcriptPath },
    cwd: '/tmp',
  };
}

// -----------------------------------------------------------------------------
// OBS-CORE: Layer 1 (core structured logging)
// -----------------------------------------------------------------------------

describe('S6-4 Layer 1: core structured logging', () => {
  test('OBS-CORE-1: thinking-only transcript (空 assistantTexts) で WARN が errors.log に残る', async () => {
    const { root, vault } = await createVault();
    try {
      const ctx = buildCtx(vault);
      const sid = 'test-session-obs-core1';
      const transcript = join(root, 'transcript.jsonl');
      // assistant 行はあるが text content が無い (thinking のみ) = 従来 silent return
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal only' }] },
      });
      await writeFile(transcript, line + '\n', 'utf8');

      await ingestNormalizedEvent(userPromptEvent(sid), ctx);
      await ingestNormalizedEvent(assistantStopEvent(sid, transcript), ctx);

      const errors = await readErrorsLog(ctx);
      assert.match(errors, /WARN: assistant_stop yielded no text/);
      assert.ok(errors.includes(`session=${sid}`), 'WARN 行に session id が含まれる');
      assert.ok(errors.includes('consumedLines=1'), 'shape (行数) のみが記録される');
      assert.ok(!errors.includes('internal only'), 'transcript 本文 (payload) は log に書かれない');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-CORE-1b: text ありの transcript では WARN を出さない (regression)', async () => {
    const { root, vault } = await createVault();
    try {
      const ctx = buildCtx(vault);
      const sid = 'test-session-obs-core1b';
      const transcript = join(root, 'transcript.jsonl');
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello observability' }] },
      });
      await writeFile(transcript, line + '\n', 'utf8');

      await ingestNormalizedEvent(userPromptEvent(sid), ctx);
      await ingestNormalizedEvent(assistantStopEvent(sid, transcript), ctx);

      const errors = await readErrorsLog(ctx);
      assert.ok(!errors.includes('yielded no text'), '正常経路では WARN なし');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-CORE-2: writeErrorLog は masking SSOT を経由する (credential 二次漏洩なし、G-1)', async () => {
    const { root, vault } = await createVault();
    try {
      const ctx = buildCtx(vault);
      // 敵対的 / 事故的に err.message へ token が混ざる想定の synthetic message
      const fakeGhp = 'ghp_' + 'a'.repeat(24);
      const fakeAnthropic = 'sk-ant-api03-' + 'b'.repeat(24);
      await writeErrorLog(ctx, `WARN: transcript not accessible: ENOENT stat '/tmp/${fakeAnthropic}/x.jsonl' token=${fakeGhp}`);

      const errors = await readErrorsLog(ctx);
      assert.ok(!errors.includes(fakeGhp), 'ghp_ token は raw で残らない');
      assert.ok(!errors.includes(fakeAnthropic), 'sk-ant- token は raw で残らない');
      assert.ok(errors.includes('ghp_***') || errors.includes('token=***'), 'mask 済 placeholder に置換される');
      assert.ok(errors.includes('sk-ant-***'), 'sk-ant-*** に置換される');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-CORE-3: resolveTranscriptWindow — TOCTOU 縮小で offset=0 リセット (F-hooks-06)', () => {
    // 縮小 (truncate / rotate): offset リセット + open 時 size を read 上限に
    assert.deepEqual(resolveTranscriptWindow(500, 1000, 300), { offset: 0, size: 300, shrank: true });
    // 成長 (追記): 現行挙動維持 — stat 時 size を上限、offset 維持
    assert.deepEqual(resolveTranscriptWindow(500, 1000, 1500), { offset: 500, size: 1000, shrank: false });
    // 不変: そのまま
    assert.deepEqual(resolveTranscriptWindow(500, 1000, 1000), { offset: 500, size: 1000, shrank: false });
    // 縮小して offset 以下になっても全再読で consume できる
    assert.deepEqual(resolveTranscriptWindow(900, 1000, 100), { offset: 0, size: 100, shrank: true });
  });
});

// -----------------------------------------------------------------------------
// OBS-ADPT: Layer 1 (adapter converter rejection reason、KIOKU_DEBUG gate)
// -----------------------------------------------------------------------------

describe('S6-4 Layer 1: adapter converter rejection reason (debug-gated)', () => {
  const CANARY = 'CANARY_PAYLOAD_VALUE_XYZ';

  test('OBS-ADPT-1: claude converter — KIOKU_DEBUG=1 で reason code を stderr に出す', () => {
    const out = withEnv('KIOKU_DEBUG', '1', () =>
      captureStderr(() => {
        const r = claudePayloadToNormalizedEvent({
          hook_event_name: 'SessionStart', // EVENT_MAP 外
          session_id: 'test-session-adpt1',
          prompt: CANARY,
        });
        assert.equal(r, null, '返却契約 (null) は不変');
      }),
    );
    assert.match(out, /claude adapter: payload rejected \(reason=UNSUPPORTED_EVENT\)/);
    assert.ok(!out.includes(CANARY), 'payload 値は stderr に書かれない (reason code のみ)');
  });

  test('OBS-ADPT-1b: claude converter — KIOKU_DEBUG 未設定では何も出さない', () => {
    const out = withEnv('KIOKU_DEBUG', undefined, () =>
      captureStderr(() => {
        claudePayloadToNormalizedEvent({ hook_event_name: 'SessionStart', session_id: 'x' });
        claudePayloadToNormalizedEvent(null);
        claudePayloadToNormalizedEvent({ hook_event_name: 'Stop' }); // session_id 欠落
      }),
    );
    assert.equal(out, '', 'debug gate が閉じている時は stderr silent (現行挙動維持)');
  });

  test('OBS-ADPT-1c: claude converter — reject 種別ごとの reason code', () => {
    const cases = [
      [null, 'INVALID_PAYLOAD'],
      [{ hook_event_name: 42 }, 'INVALID_EVENT_NAME'],
      [{ hook_event_name: 'NoSuchEvent' }, 'UNSUPPORTED_EVENT'],
      [{ hook_event_name: 'Stop', session_id: '' }, 'INVALID_SESSION_ID'],
    ];
    for (const [payload, reason] of cases) {
      const out = withEnv('KIOKU_DEBUG', '1', () =>
        captureStderr(() => {
          assert.equal(claudePayloadToNormalizedEvent(payload), null);
        }),
      );
      assert.ok(out.includes(`reason=${reason}`), `claude: ${reason} が出る`);
    }
  });

  test('OBS-ADPT-2: gemini converter — 未知 tool は UNSUPPORTED_TOOL、payload 値は出ない', () => {
    const out = withEnv('KIOKU_DEBUG', '1', () =>
      captureStderr(() => {
        const r = geminiPayloadToNormalizedEvent({
          hook_event_name: 'AfterTool',
          session_id: 'test-session-adpt2',
          tool_name: 'read_file', // TOOL_NAME_MAP 外 → reject
          tool_input: { secret: CANARY },
        });
        assert.equal(r, null);
      }),
    );
    assert.match(out, /gemini adapter: payload rejected \(reason=UNSUPPORTED_TOOL\)/);
    assert.ok(!out.includes(CANARY), 'tool_input 値は stderr に書かれない');
    assert.ok(!out.includes('read_file'), 'tool 名 (payload 値) も書かれない — reason code のみ');
  });

  test('OBS-ADPT-2b: gemini converter — tool_name 欠落は INVALID_TOOL_NAME', () => {
    const out = withEnv('KIOKU_DEBUG', '1', () =>
      captureStderr(() => {
        assert.equal(
          geminiPayloadToNormalizedEvent({
            hook_event_name: 'AfterTool',
            session_id: 'test-session-adpt2b',
          }),
          null,
        );
      }),
    );
    assert.match(out, /reason=INVALID_TOOL_NAME/);
  });

  test('OBS-ADPT-3: codex converter — Bash 以外の tool は UNSUPPORTED_TOOL', () => {
    const out = withEnv('KIOKU_DEBUG', '1', () =>
      captureStderr(() => {
        const r = codexPayloadToNormalizedEvent({
          hook_event_name: 'PostToolUse',
          session_id: 'test-session-adpt3',
          tool_name: 'Edit', // Codex は Bash のみ intercept → spoof reject
          tool_input: { file_path: CANARY },
        });
        assert.equal(r, null);
      }),
    );
    assert.match(out, /codex adapter: payload rejected \(reason=UNSUPPORTED_TOOL\)/);
    assert.ok(!out.includes(CANARY), 'tool_input 値は stderr に書かれない');
  });
});

// -----------------------------------------------------------------------------
// OBS-INJ: Layer 3 (SessionStart hook health 通知)
// -----------------------------------------------------------------------------

describe('S6-4 Layer 3: SessionStart hook health 通知', () => {
  test('OBS-INJ-1: WARN 閾値超え → hookSpecificOutput.additionalContext に通知 (LEARN#9 schema)', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n', 'utf8');
      await makeErrorsLog(vault, { warnLines: 5 });

      const { code, stdout } = await runInjector({
        vault,
        extraEnv: { KIOKU_HOOK_WARN_THRESHOLD: '3' },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      // LEARN#9: SessionStart = hookSpecificOutput。PostCompact/Stop 用の
      // top-level systemMessage を SessionStart で使わないことを shape-level で pin
      assert.ok(parsed.hookSpecificOutput, 'hookSpecificOutput wrapper');
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(!parsed.systemMessage, 'SessionStart で top-level systemMessage は使わない (LEARN#9)');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.match(ctx, /Hook health 注意/);
      assert.match(ctx, /WARN が 5 件/);
      assert.match(ctx, /doctor\.sh/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-INJ-2: WARN が閾値未満なら通知は出ない', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n', 'utf8');
      await makeErrorsLog(vault, { warnLines: 2 });

      const { code, stdout } = await runInjector({
        vault,
        extraEnv: { KIOKU_HOOK_WARN_THRESHOLD: '3' },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(!parsed.hookSpecificOutput.additionalContext.includes('Hook health 注意'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-INJ-3: 通知に log 行本文 / credential を含めない (payload dump 禁止 canary)', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n', 'utf8');
      const canary = 'CANARY_LOG_LINE_BODY_XYZ';
      const fakeToken = 'ghp_' + 'c'.repeat(24);
      await makeErrorsLog(vault, {
        warnLines: 0,
        extraLines: Array.from({ length: 6 }, (_, i) =>
          `[2026-07-09T00:00:0${i}.000Z] WARN: something ${canary} token ${fakeToken}`),
      });

      const { code, stdout } = await runInjector({
        vault,
        extraEnv: { KIOKU_HOOK_WARN_THRESHOLD: '3' },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.match(ctx, /Hook health 注意/, '閾値超えで通知は出る');
      assert.ok(!ctx.includes(canary), 'log 行の本文は注入されない (件数 + 定型文のみ)');
      assert.ok(!ctx.includes(fakeToken), 'credential は注入されない (二次漏洩なし)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-INJ-4: index.md / hot.md 不在でも閾値超えなら通知のみ注入される', async () => {
    const { root, vault } = await createVault();
    try {
      await makeErrorsLog(vault, { warnLines: 12 }); // default threshold 10 超え

      const { code, stdout } = await runInjector({ vault });
      assert.equal(code, 0);
      assert.ok(stdout.length > 0, 'index/hot 不在でも通知だけで emit される');
      const parsed = JSON.parse(stdout);
      assert.match(parsed.hookSpecificOutput.additionalContext, /Hook health 注意/);
      assert.match(parsed.hookSpecificOutput.additionalContext, /WARN が 12 件/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('OBS-INJ-5: errors.log 不在 + index.md 不在 → 従来どおり何も emit しない (regression)', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runInjector({ vault });
      assert.equal(code, 0);
      assert.equal(stdout, '', 'healthy default では出力なし (既存挙動維持)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// OBS-PARITY: Layer 2 (doctor.sh) ⇔ Layer 3 (injector) の default 値 drift 検出
// -----------------------------------------------------------------------------

describe('S6-4: Layer 2/3 default parity', () => {
  test('OBS-PARITY-1: window / threshold の default 値が doctor.sh と injector で一致', async () => {
    const doctorSrc = await readFile(DOCTOR_PATH, 'utf8');
    const injectorSrc = await readFile(INJECTOR_SRC_PATH, 'utf8');

    const doctorWindow = doctorSrc.match(/^HOOK_WARN_WINDOW_DEFAULT=(\d+)$/m);
    const doctorThreshold = doctorSrc.match(/^HOOK_WARN_THRESHOLD_DEFAULT=(\d+)$/m);
    const injWindow = injectorSrc.match(/const HOOK_WARN_WINDOW_DEFAULT = (\d+);/);
    const injThreshold = injectorSrc.match(/const HOOK_WARN_THRESHOLD_DEFAULT = (\d+);/);

    assert.ok(doctorWindow && doctorThreshold, 'doctor.sh 側に default 定数が存在する');
    assert.ok(injWindow && injThreshold, 'injector 側に default 定数が存在する');
    assert.equal(doctorWindow[1], injWindow[1], 'window default が一致 (drift 検出)');
    assert.equal(doctorThreshold[1], injThreshold[1], 'threshold default が一致 (drift 検出)');
    // 両者が同じ env 変数名を参照していることも pin
    assert.ok(doctorSrc.includes('KIOKU_HOOK_WARN_WINDOW') && injectorSrc.includes('KIOKU_HOOK_WARN_WINDOW'));
    assert.ok(doctorSrc.includes('KIOKU_HOOK_WARN_THRESHOLD') && injectorSrc.includes('KIOKU_HOOK_WARN_THRESHOLD'));
  });
});
