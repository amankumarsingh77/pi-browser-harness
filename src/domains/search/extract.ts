
const PAGE_TEXT_LIMIT = 4000;

export const buildSerpExtractionExpr = (): string => `
  (() => {
    const main = document.querySelector('#search, #rso, #main') || document.body;
    const headings = Array.from(main.querySelectorAll('a h3'));
    const seen = new Set();
    const anchors = [];
    for (const h3 of headings) {
      const a = h3.closest('a[href]');
      if (!a) continue;
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const container =
        a.closest('div.g') ||
        a.closest('div[data-hveid]') ||
        a.parentElement?.parentElement ||
        a.parentElement;
      const containerText = container ? container.innerText || '' : '';
      const heading = h3.innerText || h3.textContent || '';
      const snippet = containerText.replace(heading, '').replace(/\\s+/g, ' ').trim().slice(0, 500);
      anchors.push({ href, heading, snippet });
    }
    const pageText = (document.body.innerText || '').slice(0, ${PAGE_TEXT_LIMIT});
    return JSON.stringify({ anchors, pageText });
  })()
`;
