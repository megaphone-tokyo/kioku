// html-to-markdown.mjs — turndown + turndown-plugin-gfm で HTML → Markdown
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

function makeService() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListStyle: '-',
    emDelimiter: '*',
  });
  td.use(gfm);
  // Force stripping script/style/noscript even if Readability missed them
  td.remove(['script', 'style', 'noscript', 'iframe']);
  return td;
}

export function htmlToMarkdown(html) {
  const td = makeService();
  return td.turndown(html);
}
