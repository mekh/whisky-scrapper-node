import { chromium } from 'playwright';

import {
  CHROME_FULL_VERSION,
  CHROME_MAJOR_VERSION,
  USER_AGENT,
} from '../../src/scrape/http/headers.constants';

/**
 * The user agent and the client hints claim a Chrome version, and the browser
 * tier then runs Chromium behind them. A Playwright bump moves the engine and
 * not the constants, which would put the scraper back where it started —
 * announcing one version while running another, the exact inconsistency
 * `applyClientHints` exists to remove.
 *
 * Nothing but a launched browser can state its own version, so the guard lives
 * here rather than in a unit test.
 */
describe('the announced Chrome version', () => {
  it('matches the Chromium this project actually runs', async () => {
    const browser = await chromium.launch({ headless: true });

    try {
      const version = browser.version();

      expect(version).toBe(CHROME_FULL_VERSION);
      expect(version.split('.')[0]).toBe(CHROME_MAJOR_VERSION);
      expect(USER_AGENT).toContain(`Chrome/${CHROME_MAJOR_VERSION}.0.0.0`);
    } finally {
      await browser.close();
    }
  });
});
