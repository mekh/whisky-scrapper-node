// A price token: digits with optional thousands spaces and an optional
// 1-2 digit decimal part, e.g. "1 614", "389,00".
const PRICE = /\d[\d\s  ]*(?:[.,]\d{1,2})?/;
const SPACES = /[\s  ]/g;

/**
 * Parses a price out of free-form text such as `1 614грн` or `389,00 ₴`.
 * A comma is treated as a decimal separator only when no dot is present;
 * otherwise commas are thousands separators and dropped.
 *
 * @param text - Raw price text, possibly null.
 * @returns The numeric price, or null when nothing parseable is found.
 */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text) {
    return null;
  }

  const match = PRICE.exec(text);

  if (!match) {
    return null;
  }

  const raw = match[0].replace(SPACES, '');
  const normalized = raw.includes(',') && !raw.includes('.')
    ? raw.replace(',', '.')
    : raw.replace(/,/g, '');
  const value = Number.parseFloat(normalized);

  return Number.isFinite(value) ? value : null;
}
