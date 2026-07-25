import type { CheerioAPI } from 'cheerio';

import type { HtmlNode } from './html.interfaces';

/**
 * The text of a node with every descendant text node stripped *before* the
 * pieces are joined — the exact semantics of selectolax's `text(strip=True)`,
 * which every Python HTML adapter relies on.
 *
 * Cheerio's own `.text()` concatenates the raw text nodes instead, so
 * `<li><span>Міцність, %</span>:<span> 40 </span></li>` would come back as
 * `Міцність, %: 40 ` rather than the legacy `Міцність, %:40`. Goodwine splits
 * exactly that string on `:`, so the difference is a parity bug, not cosmetics.
 *
 * @param $ - Cheerio root of the document the node belongs to.
 * @param node - The node to read.
 * @returns The concatenated stripped text.
 */
export function strippedText($: CheerioAPI, node: HtmlNode): string {
  const children = $(node).contents().toArray();

  if (children.length === 0) {
    return $(node).text().trim();
  }

  return children.map((child) => strippedText($, child)).join('');
}

/**
 * The stripped text of the first descendant matching a selector.
 *
 * @param $ - Cheerio root of the document.
 * @param scope - Node to search inside.
 * @param selector - CSS selector to match.
 * @returns The text, or null when nothing matches.
 */
export function firstText(
  $: CheerioAPI,
  scope: HtmlNode,
  selector: string,
): string | null {
  const node = $(scope).find(selector).first().get(0);

  return node ? strippedText($, node) : null;
}

/**
 * The value of an attribute on the first descendant matching a selector.
 *
 * @param $ - Cheerio root of the document.
 * @param scope - Node to search inside.
 * @param selector - CSS selector to match.
 * @param attribute - Attribute to read.
 * @returns The attribute value, or null when absent.
 */
export function firstAttr(
  $: CheerioAPI,
  scope: HtmlNode,
  selector: string,
  attribute: string,
): string | null {
  return $(scope).find(selector).first().attr(attribute) ?? null;
}
