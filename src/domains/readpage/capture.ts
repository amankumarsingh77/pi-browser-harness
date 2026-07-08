/**
 * The JavaScript source evaluated in a loaded page to capture candidate content
 * blocks + metadata for the pure readability extractor (readability.ts). Crosses
 * the CDP boundary via Runtime.evaluate (returnByValue) and returns a JSON
 * string shaped like PageCapture.
 *
 * The DOM walk lives here (unavoidable); all scoring/selection is pure and lives
 * in readability.ts, so the decision logic stays unit-testable.
 */

/** Max bytes of body-text fallback captured for thin/structure-less pages. */
const BODY_TEXT_LIMIT = 20_000;

/** Build the capture expression. No interpolated values ⇒ no injection surface. */
export const buildPageCaptureExpr = (): string => `
  (() => {
    const BOILERPLATE = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
    const inBoilerplate = (el) => {
      for (let n = el; n; n = n.parentElement) {
        if (BOILERPLATE.has(n.tagName)) return true;
        const role = n.getAttribute && n.getAttribute('role');
        if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
      }
      return false;
    };
    const kindOf = (tag) => {
      if (/^H[1-6]$/.test(tag)) return 'heading';
      if (tag === 'LI') return 'listitem';
      if (tag === 'BLOCKQUOTE') return 'blockquote';
      if (tag === 'P') return 'paragraph';
      return 'other';
    };
    const selector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
    const root = document.querySelector('article, main, [role=main]') || document.body;
    const blocks = [];
    for (const el of root.querySelectorAll(selector)) {
      const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      let linkTextLength = 0;
      for (const a of el.querySelectorAll('a')) linkTextLength += (a.innerText || '').length;
      blocks.push({ kind: kindOf(el.tagName), text, linkTextLength, inBoilerplate: inBoilerplate(el) });
    }
    const bodyText = (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${BODY_TEXT_LIMIT});
    return JSON.stringify({ url: location.href, title: document.title, blocks, bodyText });
  })()
`;
