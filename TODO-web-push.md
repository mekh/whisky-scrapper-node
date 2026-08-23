# Web push — remaining work (backend)

The feature itself is implemented and fully tested (unit + integration); see
`CLAUDE.md` → "API contract" → "Push notifications" for the contract. What remains is
verification against a real browser and the production rollout.

## 1. End-to-end verification (local)

The code paths are covered by tests, but the full chain — VAPID keys, payload
encryption, a real push service, the service worker — has not been exercised
against a live browser yet. Checklist (dev keys are already in `.env`,
`PUSH_ENABLED=true`):

1. `pnpm start` here, `pnpm dev` in `../web`, open `http://localhost:5173` in
   Chrome, log in.
2. Settings → «Сповіщення» → flip the switch → accept the permission prompt.
   Expect: `sw.js` active in DevTools → Application → Service Workers, one row
   in `push_subscription`.
3. «Надіслати тестове» → a system notification appears; clicking it focuses
   the tab and opens `/settings/notifications`.
4. Manufacture a drop for a favorited bottling (two snapshots for one of its
   in-stock offers):

   ```sql
   INSERT INTO price_snapshot ("storeProductId","capturedOn",price,currency,"inStock",promo)
   VALUES ('<spid>', CURRENT_DATE - 1, 1000, 'UAH', true, false)
   ON CONFLICT ("storeProductId","capturedOn") DO UPDATE SET price = 1000;
   INSERT INTO price_snapshot ("storeProductId","capturedOn",price,currency,"inStock",promo)
   VALUES ('<spid>', CURRENT_DATE, 880, 'UAH', true, false)
   ON CONFLICT ("storeProductId","capturedOn") DO UPDATE SET price = 880;
   ```

5. `POST /push/digest` (Swagger at `/docs`, permission `store:sync`). Expect
   one digest push naming the whisky at −12% and a report of
   `{users: 1, items: 1, sent: 1}`.
6. Idempotency: repeat the call → `{items: 0, sent: 0}`, no notification.
7. Dead-endpoint pruning: corrupt the stored endpoint
   (`UPDATE push_subscription SET endpoint = endpoint || 'x'`), dispatch →
   the send reports `gone` and the row is deleted.
8. Sync path: trigger a manual store sync from the stores admin page and
   confirm exactly one `Push digest …` log line after it completes.

## 2. Production rollout

- Generate a **separate** production key pair (never reuse the dev keys):

  ```bash
  node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
  ```

- Add to the **host** `.env` on prod (the compose `environment:` block already
  forwards them): `PUSH_ENABLED=true`, `PUSH_VAPID_PUBLIC_KEY`,
  `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT` (a `mailto:` address).
- Deploy backend first (`scripts/deploy.sh` — the migration gate applies
  `1787432908475-push-notification`), then the frontend (its deploy fetches
  the schema from the running backend).
- Remember: rotating the public key invalidates every stored subscription —
  pair a rotation with `DELETE FROM push_subscription` and users re-enable
  the switch.

## 3. Nice-to-have

- The digest day is resolved from `MAX(capturedOn)`; if retention policies
  ever trim `price_snapshot`, revisit `PushDigestService.resolveDay`.
