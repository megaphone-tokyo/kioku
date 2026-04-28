#!/usr/bin/env node
// hooks/session-logger.mjs — deprecation shim (v0.7.0 Q2 refactor)
//
// v0.6.x まではこのファイルに Claude Code 固有の全ロジックがあった (591 行)。
// v0.7.0 で以下に再編:
//   - agent 非依存 core: hooks/session-logger-core.mjs
//   - Claude adapter:    hooks/adapters/claude.mjs  (本ファイルの移譲先)
//   - Gemini adapter:    hooks/adapters/gemini.mjs  (Task 4)
//   - Codex adapter:     hooks/adapters/codex.mjs   (Task 6)
//
// 既存 ~/.claude/settings.json が `node path/to/session-logger.mjs` を指している
// 設定をそのまま有効にするため、本ファイルは **Claude adapter への薄い shim**
// として残す。新規 install は `adapters/claude.mjs` 直接指定を推奨 (install-hooks.sh
// は v0.7.1+ で更新予定)。
//
// 明示的に `run()` を呼ぶことで、adapter 本体の "is this file the entry script?"
// 判定 (test からの import では firing しない) をバイパスする。
//
// PR #56 SF-E review note: 本 shim は **subprocess (`node session-logger.mjs`)
// 専用** 。test から ESM import するのは禁止 (run() 無条件発火で stdin 待ち hang)。
// test は必ず `hooks/adapters/claude.mjs` を直接 import して
// `claudePayloadToNormalizedEvent` 等の named export を使用する。本 shim 自体
// は isEntry gate を持たない: ~/.claude/settings.json の既存設定 (session-logger.mjs
// 直接 invocation) を壊さず backwards compat を維持するため。

import { run } from './adapters/claude.mjs';

run();
