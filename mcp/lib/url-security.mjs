// url-security.mjs — URL validation + SSRF ガード (同期)
//
// 設計書 §4.5 / §9.1 — 以下をすべて reject:
//   - loopback (127.0.0.0/8, ::1)
//   - RFC1918 private (10.x, 172.16-31.x, 192.168.x, IPv6 fc00::/7)
//   - link-local (169.254.x, fe80::/10) — AWS/GCP metadata も含む
//   - 非 http/https scheme (file, javascript, data, gopher...)
//   - URL 埋め込み credentials (http://user:pass@host)
//
// DNS rebinding 対策 (実 resolve 後の IP pin) は url-fetch.mjs 側で実施。
// 本ファイルは URL 文字列だけから判定できる部分をカバーする。

export class UrlSecurityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UrlSecurityError';
    this.code = code;
  }
}

export function validateUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new UrlSecurityError('URL parse failed', 'url_parse');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UrlSecurityError(`scheme not allowed: ${url.protocol}`, 'url_scheme');
  }
  if (url.username || url.password) {
    throw new UrlSecurityError('URL credentials not allowed', 'url_credentials');
  }
  // Node の new URL() は 2130706433 / 0x7f000001 / 0177.0.0.1 等を 127.0.0.1 に正規化するが、
  // 他ランタイムや将来の動作変更に備え、生 URL 文字列の host 部分でも非標準表記を reject する
  // (code review 2026-04-19 CRITICAL SSRF bypass fix)
  const rawHost = extractRawHost(urlStr);
  if (rawHost) {
    // 10 進整数ホスト (例: 2130706433 = 127.0.0.1)
    if (/^\d+$/.test(rawHost)) {
      throw new UrlSecurityError(`decimal IP notation not allowed: ${rawHost}`, 'url_non_standard_ip');
    }
    // 16 進オクテット (例: 0x7f.0.0.1, 0x7f000001)
    if (/(?:^|\.)0x[0-9a-fA-F]+/.test(rawHost)) {
      throw new UrlSecurityError(`hex IP notation not allowed: ${rawHost}`, 'url_non_standard_ip');
    }
    // 8 進オクテット (leading zero) — ただし "0foo.com" 等の通常ホスト名は除外
    if (/(?:^|\.)0\d+/.test(rawHost) && /^\d[\d.]*\d$/.test(rawHost)) {
      throw new UrlSecurityError(`octal IP notation not allowed: ${rawHost}`, 'url_non_standard_ip');
    }
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UrlSecurityError(`localhost not allowed: ${host}`, 'url_localhost');
  }
  if (isLoopbackIP(host)) {
    throw new UrlSecurityError(`loopback IP not allowed: ${host}`, 'url_loopback');
  }
  if (isLinkLocalIP(host)) {
    throw new UrlSecurityError(`link-local IP not allowed: ${host}`, 'url_link_local');
  }
  if (isPrivateIP(host)) {
    throw new UrlSecurityError(`private IP not allowed: ${host}`, 'url_private_ip');
  }
  return url;
}

// 生 URL 文字列から host 部分を抽出 (Node の URL 正規化前の表記を見るため)
function extractRawHost(urlStr) {
  // [IPv6] 形式
  const m1 = urlStr.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/\s@]+@)?\[([^\]]+)\]/);
  if (m1) return m1[1];
  // 通常ホスト
  const m2 = urlStr.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/\s@]+@)?([^/:\s?#]+)/);
  if (m2) return m2[1];
  return null;
}

// IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) を IPv4 dotted 表記に展開
// OS レベルでは IPv4 と同等に接続するため、loopback/link-local/private チェック時に unwrap する
function unwrapIPv4MappedV6(h) {
  // Case 1: "::ffff:127.0.0.1" (mixed dotted notation)
  const m1 = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (m1) return m1[1];
  // Case 2: "::ffff:7f00:1" (pure hex form)
  const m2 = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m2) {
    const hi = parseInt(m2[1], 16);
    const lo = parseInt(m2[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function stripBrackets(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

export function isLoopbackIP(host) {
  const h = stripBrackets(host);
  if (h === '::1') return true;
  if (/^127\./.test(h)) return true;
  const mapped = unwrapIPv4MappedV6(h);
  if (mapped && /^127\./.test(mapped)) return true;
  return false;
}

export function isLinkLocalIP(host) {
  const h = stripBrackets(host).toLowerCase();
  if (/^169\.254\./.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  const mapped = unwrapIPv4MappedV6(h);
  if (mapped && /^169\.254\./.test(mapped)) return true;
  return false;
}

export function isPrivateIP(host) {
  const h = stripBrackets(host);
  if (/^127\./.test(h)) return true;
  if (h === '::1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const mapped = unwrapIPv4MappedV6(h);
  if (mapped) {
    if (/^127\./.test(mapped)) return true;
    if (/^10\./.test(mapped)) return true;
    if (/^192\.168\./.test(mapped)) return true;
    const mm172 = mapped.match(/^172\.(\d{1,3})\./);
    if (mm172) {
      const second = parseInt(mm172[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    if (/^169\.254\./.test(mapped)) return true;
  }
  return false;
}
