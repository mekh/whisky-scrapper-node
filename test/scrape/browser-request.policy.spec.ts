import {
  firstPartyHostOf,
  isFirstPartyHost,
  isRequestAllowed,
} from '../../src/scrape/browser/browser-request.policy';

const STORE = 'rozetka.com.ua';

describe('browser request policy', () => {
  it('reads the store host out of its base URL', () => {
    expect(firstPartyHostOf('https://rozetka.com.ua')).toBe(STORE);
    expect(firstPartyHostOf('https://rozetka.com.ua/ua/viski/')).toBe(STORE);
  });

  it('treats the store and its subdomains as first party', () => {
    expect(isFirstPartyHost('rozetka.com.ua', STORE)).toBe(true);
    expect(isFirstPartyHost('xl-static.rozetka.com.ua', STORE)).toBe(true);
    expect(isFirstPartyHost('content1.rozetka.com.ua', STORE)).toBe(true);
    // A look-alike host is not a subdomain.
    expect(isFirstPartyHost('notrozetka.com.ua', STORE)).toBe(false);
    expect(isFirstPartyHost('rozetka.com.ua.evil.example', STORE)).toBe(false);
  });

  it('lets the store document and scripts through', () => {
    expect(isRequestAllowed(
      'https://rozetka.com.ua/ua/viski/c4649130/page=2/',
      'document',
      STORE,
    )).toBe(true);
    expect(isRequestAllowed(
      'https://xl-static.rozetka.com.ua/assets/main.js',
      'script',
      STORE,
    )).toBe(true);
    expect(isRequestAllowed(
      'https://rozetka.com.ua/api/x',
      'xhr',
      STORE,
    )).toBe(true);
  });

  it('aborts every third-party host, whatever it serves', () => {
    [
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://www.googletagmanager.com/gtm.js?id=GTM-X',
      'https://www.google-analytics.com/collect',
      'https://accounts.google.com/gsi/client',
      'https://scripts.clarity.ms/0.8.69/clarity.js',
      'https://o4511387512274944.ingest.de.sentry.io/api/1/envelope/',
      'https://static.cloudflareinsights.com/beacon.min.js',
      'https://analytics.tiktok.com/i18n/pixel/events.js',
    ].forEach((url) => {
      expect(isRequestAllowed(url, 'script', STORE)).toBe(false);
      expect(isRequestAllowed(url, 'fetch', STORE)).toBe(false);
    });
  });

  it('lets the Cloudflare challenge platform through', () => {
    expect(isRequestAllowed(
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'script',
      STORE,
    )).toBe(true);
    expect(isRequestAllowed(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/',
      'document',
      STORE,
    )).toBe(true);
    // The same-origin half of the challenge is first party on its own.
    expect(isRequestAllowed(
      'https://rozetka.com.ua/cdn-cgi/challenge-platform/scripts/jsd/main.js',
      'script',
      STORE,
    )).toBe(true);
  });

  it('never applies the type filter to the challenge', () => {
    // Whatever the challenge platform serves goes through, images included.
    expect(isRequestAllowed(
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/logo.png',
      'image',
      STORE,
    )).toBe(true);
    expect(isRequestAllowed(
      'https://challenges.cloudflare.com/turnstile/v0/font.woff2',
      'font',
      STORE,
    )).toBe(true);
    // So does anything Cloudflare serves under the store's own /cdn-cgi/.
    expect(isRequestAllowed(
      'https://rozetka.com.ua/cdn-cgi/challenge-platform/h/b/img/x.png',
      'image',
      STORE,
    )).toBe(true);
    expect(isRequestAllowed(
      'https://rozetka.com.ua/cdn-cgi/rum?x=1',
      'other',
      STORE,
    )).toBe(true);
    // A third party under a look-alike path is still a third party.
    expect(isRequestAllowed(
      'https://evil.example/cdn-cgi/challenge-platform/x.js',
      'script',
      STORE,
    )).toBe(false);
  });

  it('aborts images, media and fonts even on the store', () => {
    expect(isRequestAllowed(
      'https://content1.rozetka.com.ua/goods/images/big/1.jpg',
      'image',
      STORE,
    )).toBe(false);
    expect(isRequestAllowed(
      'https://xl-static.rozetka.com.ua/assets/fonts/x.woff2',
      'font',
      STORE,
    )).toBe(false);
    expect(isRequestAllowed(
      'https://content.rozetka.com.ua/video/x.mp4',
      'media',
      STORE,
    )).toBe(false);
  });

  it('refuses a request whose destination cannot be read', () => {
    expect(isRequestAllowed('not a url', 'script', STORE)).toBe(false);
  });
});
