// robots-check.mjs — robots.txt を fetch してルールを評価する
import { parseRobotsTxt, isAllowed } from './robots-parser.mjs';
import { fetchUrl, FetchError } from './url-fetch.mjs';

export class RobotsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RobotsError';
    this.code = code;
  }
}

const USER_AGENT_NAME = 'kioku-wiki';

export async function checkRobots(targetUrl, opts = {}) {
  if (process.env.KIOKU_URL_IGNORE_ROBOTS === '1') return; // bypass
  const url = new URL(targetUrl);
  const robotsUrl = opts.robotsUrlOverride || `${url.origin}/robots.txt`;
  let body;
  try {
    const r = await fetchUrl(robotsUrl, { timeoutMs: 10_000, maxBytes: 500_000, accept: 'text/plain' });
    if (r.status !== 200) {
      return; // 404 / 5xx → allow
    }
    body = r.body;
  } catch (err) {
    if (err instanceof FetchError && (err.code === 'not_found' || err.code === 'server_error')) {
      return; // allow when robots.txt is missing/broken
    }
    if (err instanceof FetchError && err.code === 'fetch_failed') {
      return;
    }
    throw err;
  }
  const rules = parseRobotsTxt(body);
  if (!isAllowed(rules, USER_AGENT_NAME, url.pathname + url.search)) {
    throw new RobotsError(`robots.txt disallows ${url.pathname}`, 'robots_disallow');
  }
}
