# PassPlate: Project Requirements

## 1. Overview

PassPlate is software that a restaurant (or a small chain) runs for itself:

- Customers order by dine-in QR, pickup or delivery.
- The kitchen sees tickets live.
- Dispatchers track the restaurant's own drivers on a live map.
- Owners see live business numbers.

**Goal:** a production-grade system that stays correct and responsive during a dinner rush or a sudden traffic spike, with load test results to prove it.

## 2. Roles

| Role | What they do |
|---|---|
| Diner / Customer | Browses the menu, orders, pays, tracks delivery |
| Kitchen staff | Sees tickets, moves them through cooking states |
| Dispatcher | Assigns ready delivery orders to drivers, watches the map |
| Driver | Accepts jobs, shares live location, confirms delivery |
| Manager / Owner | Edits the menu and stock, manages staff, views the dashboard |
| Platform admin | Manages restaurants (tenants) and sees system health |

## 3. Functional requirements

### 3.1 Menu and stock

- **FR-1** Managers create categories, items, modifiers (size, extras), prices, photos and allergen tags.
- **FR-2** Each item can have a stock count or be marked sold out. A change reaches every open diner screen within 2 seconds.
- **FR-3** Opening hours and per-location menus, with ordering blocked outside hours.

### 3.2 Ordering

- **FR-4** A dine-in QR code is tied to a table. Everyone at the table shares one live cart, and edits from several phones merge without losing items.
- **FR-5** Pickup and delivery ordering from a public link. Delivery addresses are checked against the restaurant's delivery radius.
- **FR-6** Placing an order checks stock atomically, so two people can never both buy the last portion.
- **FR-7** Every order placement carries an idempotency key. Double taps, retries or a refresh never create duplicate orders or duplicate charges.
- **FR-8** Payment through Stripe test mode, with the bill split per person for dine-in. Card data never touches PassPlate servers.
- **FR-9** The diner sees live order status: received, cooking, ready, out for delivery, delivered.

### 3.3 Kitchen display

- **FR-10** New tickets appear within 1 second (p95) of payment confirmation, with sound and highlight.
- **FR-11** Staff move tickets through an explicit state machine. Invalid transitions are rejected, and every transition is stored with who, when and from which device.
- **FR-12** Tickets are color coded by age, with a "late" warning past a target prep time.
- **FR-13** The kitchen screen survives Wi-Fi drops. It shows an offline banner, queues taps locally and replays them on reconnect without missing or duplicating any ticket.

### 3.4 Delivery and live map

- **FR-14** The dispatch map shows every active driver, their route, the ETA, and the orders waiting for a driver.
- **FR-15** A dispatcher assigns an order to a driver by clicking. The system also suggests the nearest available driver.
- **FR-16** The driver app (a mobile web page) accepts jobs, shares GPS every 3 seconds during an active delivery only, and confirms pickup and drop-off.
- **FR-17** The customer gets a private tracking link showing the driver's position and a live ETA.
- **FR-18** Geofencing marks "driver arriving" within 200 m and notifies the customer.
- **FR-19** A driver simulator moves fake drivers along real road routes, for demos and load tests.
- **FR-20** The map sits behind a MapProvider interface. Google Maps is the primary provider (Maps JavaScript, Routes, Places Autocomplete), and MapLibre is the automatic fallback.

### 3.5 Owner dashboard

- **FR-21** Live order count, revenue, average prep time and average delivery time, plus best sellers.
- **FR-22** Staff accounts with roles and invite links.

### 3.6 Multi-tenancy

- **FR-23** Each restaurant is a tenant, and its data is fully isolated from other tenants.
- **FR-24** A restaurant can have several locations, each with its own menu, stock, staff and drivers.

## 4. Capacity targets (design load)

| Metric | Target |
|---|---|
| Restaurants (tenants) | 500 |
| Sustained order rate | 50 orders/s |
| Spike | 200 orders/s for 2 minutes |
| Concurrent WebSocket connections | 20,000 |
| Active drivers streaming location | 2,000 (about 670 updates/s) |
| Sudden spike tolerance | 5x normal traffic within 60 s, error rate under 0.5% |

## 5. Performance budgets

| Path | Target (p95 at design load) |
|---|---|
| Menu read | under 150 ms (served from cache) |
| Order placement | under 400 ms |
| Order to kitchen screen | under 1 s |
| Driver location to map | under 2 s |
| Diner page first load on mid-range phone, 4G | LCP under 2.5 s |
| Diner page JavaScript | under 150 KB gzipped |
| Availability of ordering and kitchen | 99.9% monthly |

## 6. Traffic protection and resilience

### 6.1 Stateless scaling

- **NFR-1** The web, API and realtime gateway are separate stateless services. Any instance can die without losing data, and more instances can be added behind the load balancer.
- **NFR-2** WebSocket fan-out goes through Redis pub/sub, so a ticket reaches the kitchen screen no matter which instance it is connected to.
- **NFR-3** Autoscaling on CPU, memory and open connections per instance, with a hard connection cap per instance.

### 6.2 Rate limiting and load shedding

- **NFR-4** Token bucket rate limits per IP, per user and per tenant, stored in Redis. Over the limit gets HTTP 429 with Retry-After.
- **NFR-5** Priority under overload: (1) order placement and kitchen updates, (2) driver location and tracking, (3) dashboard and analytics. Lower tiers degrade first, for example by refreshing the dashboard every 30 s instead of live.
- **NFR-6** Request body size limits, and a timeout on every request.

### 6.3 Real-time reliability

- **NFR-7** Every event has a sequence number. A reconnecting client sends its last event id and receives everything it missed, so no ticket is ever lost.
- **NFR-8** Clients reconnect with exponential backoff plus jitter, so 20,000 clients don't reconnect at the same instant after a deploy.
- **NFR-9** Backpressure: each connection has a send buffer limit. For driver locations only the latest point matters, so older unsent points are dropped and coalesced.
- **NFR-10** Graceful drain on deploy: instances stop taking new connections, tell clients to reconnect elsewhere, then shut down.

### 6.4 Data correctness

- **NFR-11** Stock is decremented with a conditional atomic update (only succeeds if enough stock remains).
- **NFR-12** Transactional outbox: order changes and their events are written in one database transaction, and a worker publishes them. An event is never sent for an order that didn't save, or missed for one that did.
- **NFR-13** Stripe webhooks are signature-verified and processed idempotently, and retries are safe.

### 6.5 Database

- **NFR-14** Connection pooling (PgBouncer), a statement timeout, and indexes for every hot query, checked with EXPLAIN in tests.
- **NFR-15** Analytics read from a replica or precomputed aggregates, never from the hot order tables during a rush.
- **NFR-16** Automated daily backups with point-in-time recovery, and a restore test documented in the README.

### 6.6 Caching

- **NFR-17** Menus are cached in Redis and on a CDN, and invalidated on edit. Images go through the CDN with modern formats and sizes.
- **NFR-18** ETag and Cache-Control headers on public reads.

### 6.7 External services

- **NFR-19** Every call to Stripe or Google Maps has a timeout, retries with jitter and a circuit breaker.
- **NFR-20** Maps cost guard:
  - The map script loads only on map pages.
  - The route is fetched once per assignment and cached.
  - The ETA is recomputed at most every 30 s, or when the driver leaves the route.
  - The API key is restricted to the site's domain, with daily quota caps.
- **NFR-21** If Google Maps fails or hits its quota, PassPlate switches to MapLibre with a straight-line ETA, and ordering keeps working.

### 6.8 Slow work off the request path

- **NFR-22** Receipts, notifications and analytics rollups run in background workers fed by the outbox, never inside the order request.

## 7. Failure scenarios the app must survive

| Scenario | Required behavior |
|---|---|
| Friday rush, 5x traffic in 60 s | Orders still placed, under 0.5% errors, dashboard slows first |
| One API or gateway instance crashes | Clients reconnect to others, no lost tickets |
| Redis goes down | Orders still save to Postgres. Live updates pause, and kitchen screens fall back to polling every 5 s |
| Kitchen tablet loses Wi-Fi for 5 minutes | Taps are queued and replayed, and missed tickets arrive on reconnect |
| Customer double-taps "Pay" | Exactly one order, exactly one charge |
| Stripe is slow or down | Clear message, order held as pending payment, no double charge |
| Google Maps quota hit | Map switches to MapLibre, ETAs keep updating |
| Bad deploy | Health checks fail, rollout stops, one-command rollback |

## 8. Security and privacy

- **SEC-1** Tenant isolation using Postgres row-level security, plus automated tests proving one tenant can never read another tenant's data.
- **SEC-2** Role-based access on every endpoint and WebSocket channel, checked on the server.
- **SEC-3** Input validation on every request with shared Zod schemas.
- **SEC-4** OWASP Top 10 covered: CSRF protection, strict Content Security Policy, secure cookies, no secrets in the client.
- **SEC-5** Driver location is shared only during an active delivery and deleted after 30 days. Tracking links expire after delivery.
- **SEC-6** Audit log for staff actions such as refunds, menu edits and role changes.
- **SEC-7** Secrets in environment variables, never in the repo. Dependency scanning in CI.

## 9. Observability

- **OBS-1** OpenTelemetry traces across web, API, gateway and workers.
- **OBS-2** Structured logs with request id, tenant id and user id.
- **OBS-3** Metrics: request rate, errors, latency, open connections, queue depth, database pool usage.
- **OBS-4** Dashboards and alerts based on the targets in sections 4 and 5.
- **OBS-5** Health endpoints for liveness and readiness.

## 10. Testing

- **TEST-1** Unit tests for the state machine, pricing, stock and ETA logic.
- **TEST-2** Integration tests against real Postgres and Redis using Testcontainers.
- **TEST-3** Playwright end-to-end tests, including several browsers editing one table cart at once, plus the full journey from order to kitchen to driver to delivered.
- **TEST-4** k6 load tests at design load, a spike test (5x in 60 s), a 2-hour soak test, and a stress test that pushes until it breaks, with the breaking point recorded.
- **TEST-5** Chaos tests: kill an instance, stop Redis and drop the network during a run, checking the behavior in section 7.
- **TEST-6** Performance budget checks (Lighthouse and bundle size) in CI.
- **TEST-7** All results published in the README with charts.

## 11. Accessibility and UX

- **UX-1** WCAG 2.1 AA, keyboard usable, screen reader labels.
- **UX-2** Mobile-first diner and driver pages, and a large-type kitchen display readable from 2 m away.
- **UX-3** Clear loading, empty, error and offline states on every screen.

## 12. Architecture and stack

| Part | Choice |
|---|---|
| Web app | TanStack Start (React), TypeScript, Tailwind, shadcn/ui |
| API and realtime gateway | Hono on Bun, run as separate services |
| Database | Postgres with Drizzle, PgBouncer |
| Cache, pub/sub, rate limits, live locations | Redis |
| Background jobs | Workers reading the Postgres outbox |
| Auth | Better Auth |
| Payments | Stripe test mode |
| Maps | Google Maps, MapLibre fallback |
| Tooling | Docker Compose locally, GitHub Actions CI, OpenTelemetry, Sentry, k6, Playwright |
| Hosting | Fly.io (or similar) in two regions, with a CDN for static files |

## 13. Out of scope

- Real money or real card payments
- A multi-restaurant customer marketplace
- Native app store releases (Expo tablet app is a stretch goal only)
- Driver payroll or tax handling

## 14. Milestones and acceptance criteria

| # | Milestone | Done when |
|---|---|---|
| 1 | Menu, ordering, kitchen board | An order placed on a phone appears on the kitchen screen in under 1 s |
| 2 | Shared carts, stock locking, state machine | 10 simulated diners racing for the last item: exactly one wins |
| 3 | Delivery and live map | A real phone's walk shows on the dispatch map, and 200 simulated drivers move smoothly |
| 4 | Multi-tenancy, payments, dashboard | Isolation tests pass, and duplicate payment tests produce one charge |
| 5 | Hardening and deploy | Every k6 target and every failure scenario passes, the app is live, and the README has the results |
