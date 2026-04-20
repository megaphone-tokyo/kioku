#!/usr/bin/env node
// url-extract-cli.mjs — shell / MCP から spawn される node CLI。
//
// 使い方:
//   node url-extract-cli.mjs --url <url> --vault <vault> --subdir <subdir>
//     [--refresh-days <n|never>]
//     [--title <s>] [--source-type <s>] [--tags <a,b,c>]
//     [--robots-override <url>]
//
// stdout: 成功時 JSON (status, path, source_sha256, ...)
// stderr: エラー (`Error (<code>): <message>`)
// exit code:
//   0  正常
//   2  引数エラー
//   3  robots.txt Disallow
//   4  fetch / extraction 失敗
//   5  書き込み / その他失敗

import { extractAndSaveUrl } from './url-extract.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseRefreshDays(raw) {
  if (raw === undefined || raw === true) return undefined;
  if (raw === 'never') return 'never';
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  // caller provides a bad value — let extractAndSaveUrl fall back to env default.
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || args.url === true) {
    process.stderr.write('Error: --url required\n');
    process.exit(2);
  }
  if (!args.vault || args.vault === true) {
    process.stderr.write('Error: --vault required\n');
    process.exit(2);
  }
  const refreshDays = parseRefreshDays(args['refresh-days']);
  const callOpts = {
    url: args.url,
    vault: args.vault,
    subdir: typeof args.subdir === 'string' ? args.subdir : 'articles',
    title: typeof args.title === 'string' ? args.title : undefined,
    sourceType: typeof args['source-type'] === 'string' ? args['source-type'] : undefined,
    tags: typeof args.tags === 'string'
      ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [],
    robotsUrlOverride: typeof args['robots-override'] === 'string'
      ? args['robots-override']
      : undefined,
  };
  // refreshDays は has-own-property で gate される (orchestrator の Deviation 2)。
  // undefined を明示的に渡すと hasOwnProperty が true になり early-return が engage し、
  // UI9 smoke-test を破壊する。そのため明示値がある時だけ属性追加。
  if (refreshDays !== undefined) callOpts.refreshDays = refreshDays;
  try {
    const r = await extractAndSaveUrl(callOpts);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  } catch (err) {
    const code = err.code || 'unknown';
    // red M-2 fix (2026-04-20): err.message に内部 IP / 解決済み hostname /
    // attacker-controlled redirect URL がそのまま入るケース (例: FetchError(
    // 'resolved IP is private: evil.com → 10.0.0.5', 'dns_private')) が
    // cron 側 log に leak する。MCP 経路は mapFetchErrorAndThrow で scrub 済みだが、
    // cron → extract-url.sh → node CLI の経路は生メッセージ。code のみ出力して
    // attacker-controlled 文字列の log 混入を防ぐ。
    const securityCodes = new Set([
      'fetch_failed', 'timeout', 'dns_failed', 'dns_private',
      'auth_required', 'not_found', 'server_error', 'client_error',
      'redirect_invalid', 'redirect_limit', 'scheme_downgrade',
      'url_scheme', 'url_credentials', 'url_parse', 'url_private_ip',
      'url_loopback', 'url_link_local', 'url_metadata',
    ]);
    if (securityCodes.has(code)) {
      process.stderr.write(`Error (${code}): blocked by security policy\n`);
    } else {
      // not_html / extraction_failed / robots_disallow など、アプリケーション
      // エラーは message を出して OK (既定の msg は attacker-controlled ではない)。
      process.stderr.write(`Error (${code}): ${err.message}\n`);
    }
    if (code === 'robots_disallow') process.exit(3);
    if (securityCodes.has(code) || code === 'extraction_failed' || code === 'not_html') {
      process.exit(4);
    }
    process.exit(5);
  }
}

main();
