# Donor PWA and audience participation

The `/donor` app uses synthetic data only. It generates a nickname and a fixed mock
eligibility profile, asks for a pretend group and one of four demo city locations,
and requires explicit participation consent. It never asks for a phone number,
email, real health details or device location. Acceptance expresses willingness;
collection, screening and stock reservation remain separate workflow steps.

## Run and configure

Use Node 24 and the existing Atlas/Clerk/Inngest setup from [registry.md](registry.md)
and [workflows.md](workflows.md). The audience join itself needs MongoDB transactions
and schema setup; it does not need an audience Clerk account. Staff operations keep
their existing Clerk authorization.

1. Run the guarded schema upgrade on the existing dedicated demo database:
   `npm run registry -- upgrade --confirm=pulsegrid_dev` (substitute its exact name;
   see the registry CLI's usage). This adds audience session and cleanup indexes
   without resetting stock, requests, seed hashes or institution edits.
2. Generate keys once with `npm run donor:keys -- mailto:YOUR_OPERATOR_ADDRESS` or
   supply a real HTTPS operator contact page as the argument. This writes the four
   server-only settings into ignored `.env.local`, without printing secrets. It
   refuses to overwrite existing key material. An alternative is to generate VAPID
   with `web-push` and a 32-byte random hex encryption key yourself.
3. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and
   `DONOR_PUSH_ENCRYPTION_KEY` in the deployment's server environment, then redeploy.
   Keep the key pair and encryption key stable across redeploys. The public VAPID
   key is returned only through the authenticated donor API. No private key is
   included in a browser bundle, manifest, notification, log or response.
4. Serve over HTTPS. Localhost supports local browser development but a QR pointing
   to localhost does not reach a volunteer's phone. Open `/donor` on the shared
   deployment and project its QR code or share that exact address.

Optional email is deliberately unused: the audience supplies no email address.
There is no SMS integration or external QR service.

## Rehearse the complete loop

1. Open `/donor` in the volunteer's browser, choose a pretend compatible group and
   a demo city, read the consent text, then join. The nickname, next eligible date
   and exact 24-hour expiry appear. The API sets a random 256-bit bearer session in
   an HttpOnly, SameSite=Strict cookie scoped to `/api/donor`; HTTPS adds Secure.
   MongoDB stores only its SHA-256 digest. This is a limited audience session with
   no staff or generic registry privileges, not a fabricated Clerk membership.
2. Optionally install and enable notifications. **Android Chrome:** menu → Install
   app / Add to Home screen → launch the app → Enable notifications. **iOS 16.4+:**
   Safari → Share → Add to Home Screen → launch that icon → Enable notifications.
   Permission is requested only after the button is pressed. Denied, unsupported
   or unconfigured push leaves the in-app path available.
3. Use a signed hospital in the same demo area to create a compatible **critical**
   durable Code Red with a stock shortage and a future deadline. The collection
   bank must be within the donor wave radius of the chosen city location. The
   browser's local Code Red simulator does not alert the live registry donors.
   Seed donors may consume wave slots; use a dedicated controlled fixture when
   demonstrating an individual volunteer.
4. Wait for the durable 5/10/25 km wave. Donors poll every five seconds while
   visible/online, up to 120 attempts; Refresh resumes the bounded polling. Push
   opens the specific alert in a full-screen native dialog. Review request ID,
   pretend group, component, quantity, bank and response deadline.
5. Accept or decline. A response is first saved to IndexedDB with a UUID and donor
   ownership. **Pending** means local only; **Received** means the server committed
   the response; **Too late** means it was not applied. Response receipts, alert
   state and request serialization are transactional. Replaying the same key does
   not repeat effects; reusing a key with different content is rejected.
6. On the signed hospital's durable Code Red screen, observe the accepted/declined
   totals on the next five-second status read. No donor nickname, endpoint or
   session secret is exposed there. The response attempts a deduplicated Inngest
   wake after commit; a lost wake is recovered by the original workflow's timed
   recheck (at most five minutes, normally the current three-minute wave deadline).
   No acceptance increments allocated stock or synthetic-use counts.
7. While an alert is loaded, disconnect, respond, and observe Pending. Reloading
   fully offline shows a public offline page; the queue stays in IndexedDB.
   Reconnect and reopen the app to sync, or use Sync responses / refresh. Chrome's
   Background Sync can also flush the queue, but it is optional. iOS does not need
   Background Sync: foreground reconnect/focus/manual refresh provides the fallback.
   Close/fulfil the request before reconnecting to demonstrate Too late.
8. Opt out: new wave selection and push dispatch exclude the donor; subscription
   ciphertext is removed and pending local replies are cleared. Delete: donor,
   subscription, alerts and response receipts are deleted transactionally and the
   cookie is cleared. At the exact expiry instant the server denies the session
   and wave matching immediately, even if MongoDB TTL cleanup has not run yet.

## Delivery and privacy boundaries

- Push subscriptions use AES-256-GCM with a fresh 96-bit IV and the donor ID as
  authenticated associated data. Tampering and moving ciphertext between donors
  fail authentication. Known HTTPS push-service hosts are allowlisted to prevent
  arbitrary server-side requests. New provider hosts require explicit review.
- Durable wave selection retains eligibility, compatibility, geospatial radius,
  opt-out, quiet hours, four-alert monthly cap, 24-hour cooldown and request/donor
  deduplication. Dispatch rechecks eligibility, expiry, wave membership, request
  shortage, opt-out, quiet hours and fatigue before the provider call.
- Fan-out uses four parallel senders, at most 100 records per wave delivery call,
  provider timeout 10 seconds, a 30-second delivery lease and a provider topic to
  collapse repeated notifications. A crash after provider acceptance but before
  recording SENT can repeat a notification: exactly-once provider delivery is not
  claimed. The response itself remains transactionally idempotent.
- 404/410 removes the exact expired encrypted subscription and marks it EXPIRED;
  the donor can enable notifications again. 429/5xx/network failures retry the
  separate durable notification job; permanent errors leave the in-app alert available. A push
  permission revocation can be observed as a provider error or browser denial.
  Notifications contain a generic demo message and alert ID, without health data.
  A notification already in flight cannot be recalled after opt-out or closure;
  opening/responding always revalidates against the current server state.
- Donor documents have a BSON Date TTL. Audience alerts and response receipts copy
  that expiry and have their own TTL indexes. Explicit deletion removes all three
  immediately. Staff lifecycle history and accepted totals are not fake clinical
  records. TTL is eventual physical cleanup; logical session expiry is immediate.
- Service-worker caches contain exactly the public offline document, manifest and
  two icons. The worker does not cache authenticated HTML, API data or application
  session secrets. It intercepts navigation only to `/donor`; staff portals and
  public-board caching retain their own behavior. IndexedDB contains only queued
  IDs, chosen response and receipt state. Delete clears it; expired sessions clear
  it when the foreground app next checks. Background sync never applies another
  donor's pending response. Device storage can persist while a device stays offline.
- Registration is capped at 200 joins globally per hour using a transactional
  counter, avoiding IP, phone or email collection. This is a classroom limit,
  not an internet-scale abuse-protection service. Clearing browser cookies loses
  access to that donor session; TTL will still remove its data.
- Browser data is separate from the simulator. Production database/auth failures
  are displayed honestly; there is no browser fixture or authentication bypass in
  the production route. Automated API fixtures live only in tests.

## Verification and remaining device gate

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`,
`npm run build`, and `npm run test:e2e`. The donor integration suite uses an actual
temporary single-node MongoDB replica set, exercises real transactions, wave
selection, encrypted storage, concurrent retries, expiry before TTL cleanup and
staff status totals. Provider sending is injected; no notification is sent by the
test suite. Browser tests use the production Next app with explicit synthetic
HTTP responses and actual IndexedDB/service workers.

Physical Android Chrome and installed iOS push behavior **cannot be certified by
desktop/mobile emulation**. Record this checklist on actual devices using the
shared HTTPS deployment:

| Observation | Android Chrome | Installed iPhone PWA |
|---|---|---|
| Device, OS/browser version, date and deployment URL | Pending | Pending |
| QR opens the right registration route | Pending | Pending |
| Install, launch standalone, generated nickname and expiry | Pending | Pending |
| Denied permission → usable in-app alert | Pending | Pending |
| Granted permission → actual background push and alert opens | Pending | Pending |
| Accept → Received → staff totals update, no allocated stock | Pending | Pending |
| Offline response → reopen/reconnect → same-key receipt | Pending | Pending |
| Request closes offline → Too late on reconnect | Pending | Pending |
| Opt-out, explicit deletion and 24-hour expiry denial | Pending | Pending |

Do not present a mocked provider send, a Pixel viewport or a local HTTP worker
install as real Android/iOS delivery. Evidence and automated results are retained
in [`_ai_context/STAGE_9_EVIDENCE.md`](../../_ai_context/STAGE_9_EVIDENCE.md).

Official references checked 2026-10-29:
[web-push API and VAPID](https://github.com/web-push-libs/web-push),
[WebKit Home Screen Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[Apple Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
