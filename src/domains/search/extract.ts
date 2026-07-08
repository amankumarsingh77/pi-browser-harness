/**
 * The JavaScript source evaluated inside the Google SERP page to capture raw
 * anchors + page text. This string crosses the CDP boundary via
 * Runtime.evaluate (returnByValue) and returns a JSON string that
 * `parseGoogleSerp` / `classifySerp` consume on the harness side.
 *
 * ADR-0001: anchors are selected structurally (a link carrying an <h3>), not by
 * Google CSS class names, so cosmetic markup churn does not break extraction.
 */

/** Max bytes of page text captured for CAPTCHA / no-results classification. */
const PAGE_TEXT_LIMIT = 4000;

/**
 * Build the extraction expression. Takes no interpolated values, so it is a
 * fixed source string (no injection surface). Returns
 * `JSON.stringify({ anchors, pageText })`.
 */
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
