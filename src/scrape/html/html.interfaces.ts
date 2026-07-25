import type { CheerioAPI } from 'cheerio';

/**
 * One parsed DOM node, as cheerio hands it back from `toArray()`/`get()`.
 * Derived from the public API on purpose: the node classes live in
 * `domhandler`, a transitive dependency that must not be imported directly.
 */
export type HtmlNode = Parameters<CheerioAPI['contains']>[0];
