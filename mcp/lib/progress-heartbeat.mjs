// progress-heartbeat.mjs — 長時間処理中の MCP progress notification ヘルパ
//
// 2026-04-20 v0.3.4: Claude Desktop 等の MCP client が tool call に対して
// 既定 60 秒で request timeout を切る問題への対応。client が `_meta.progressToken`
// を送ってきた場合、その token に対して periodic に `notifications/progress` を
// 送り返すことで client 側の idle timeout をリセットし、実際の処理が完走するまで
// 待機してもらえるようにする。
//
// 使い方:
//   const stop = startHeartbeat(sendProgress, 'ingesting PDF');
//   try {
//     await longRunningWork();
//   } finally {
//     await stop();  // 停止 + 最終 progress を送る
//   }
//
// - sendProgress が null/undefined (client が progressToken を送っていない)
//   の場合は何もせず no-op stop() を返す。handler 側は分岐不要。
// - 既定間隔 15 秒 (Desktop の 60s timeout を 4 回リセットする計算、safety margin 大)
// - stopMessage で「XXX 完了」等の最終 progress を送れる

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * @param {((msg?: string) => Promise<void>) | null | undefined} sendProgress
 *   server.mjs wrap が injection 経由で渡す関数 (無ければ no-op)。
 * @param {string} [initialMessage] - ハートビート開始時に 1 回送るメッセージ。
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - 送信間隔 (ms)、既定 15_000。
 * @returns {() => Promise<void>} stop 関数。interval clear + 最終 progress 送信。
 */
export function startHeartbeat(sendProgress, initialMessage, opts = {}) {
  // client が progressToken を送っていない場合 sendProgress は null。
  // handler 側を特別扱いしなくて済むよう no-op stop を返す。
  if (typeof sendProgress !== 'function') {
    return async () => {};
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // sendProgress の同期 throw も reject も完全に吸収するヘルパ。
  // client 側切断 / transport error 等で interval 全体が落ちるのを防ぐ。
  const safeSend = (msg) => {
    Promise.resolve()
      .then(() => sendProgress(msg))
      .catch(() => { /* ignore — heartbeat は best-effort */ });
  };

  // 開始時に即 1 回送る (progressToken が見えていることを確認して client に通知)。
  if (initialMessage) safeSend(initialMessage);

  let stopped = false;
  const tickMessage = initialMessage ? `${initialMessage} (in progress)` : 'in progress';
  const timer = setInterval(() => {
    if (stopped) return;
    safeSend(tickMessage);
  }, intervalMs);

  return async (stopMessage) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopMessage) {
      // 最終 progress は await して client に必ず届ける (stop 直後に結果 JSON を
      // 返す場合、timing race で最終 progress が切断される可能性があるため)。
      try { await sendProgress(stopMessage); } catch { /* ignore */ }
    }
  };
}
