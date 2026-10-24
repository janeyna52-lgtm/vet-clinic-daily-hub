# PawCare – Veterinary Clinic & Pet Vaccination Daily Hub (React UI)

Front-end only. Data lives in memory (`SEED` in `src/lib.jsx`) and resets on refresh.

    npm install
    npm run dev

## Demo accounts
| Role | Username | Password |
|---|---|---|
| Clinic Administrator | admin | Admin123 |
| Veterinarian | vet | Vet12345 |
| Vet Assistant | assistant | Assist123 |
| Pet Owner | owner | Owner123 |

## Structure
- `src/pages/Landing.jsx`, `src/pages/Login.jsx` – public pages
- `src/roles/` – one file per role: its own menu, dashboard and theme
- `src/Portal.jsx` – shared sidebar/header shell; `src/EntityPage.jsx` – CRUD list + validated form
- `src/lib.jsx` – mock data, validation rules, entity config, shared components

## Connecting a back end later
Replace the `db`/`setDb` state in `src/App.jsx` and the add/edit/delete handlers in `src/EntityPage.jsx` with API calls. Passwords are plain text in the mock data; hash them server-side.

## Permissions (C = create, R = read, U = update, D = delete)
| Section | Admin | Vet | Assistant | Owner |
|---|---|---|---|---|
| User accounts | CRUD | none | none | none |
| Owners | CRUD | R | CRU | none (menu hidden) |
| Pets | CRUD | CRU | CRU | R, own pets only |
| Appointments | CRUD | CRU | CRU | CRU, own pets only |
| Vaccinations | CRUD | CRUD | CRU | R, own pets only |
| Consultations | R | CRUD | R | R, own pets only |
| Reports | yes | yes | no | no |

Rules live in each entity's `perm` in `src/lib.jsx`. Buttons are hidden in the UI, and `src/EntityPage.jsx` re-checks them on save and delete.

## Account activation

Sign up → verify the email link → enter the SMS OTP → log in with your password.
Email links open the OTP screen directly. Verification sessions cannot open the
portal; completing OTP clears them and returns to login. Reloading the OTP screen
resumes the same account's pending verification.

Run `npm run test:auth` with Node.js 24+ for the HTTP authentication regression
checks. Tests isolate database and message delivery dependencies with Node's
experimental module mocking; they do not send real email/SMS or use a live database.

## Persistent account settings

Signed-in owners, assistants, veterinarians and administrators use
`/api/auth/profile` for their own registration details and profile photo.
Photo and contact saves require the active verified session; a server failure
is shown instead of reporting a temporary browser-only save. Photos are resized
in the browser and stored in PostgreSQL's `account_photos` table. The table is
included in `server/database/schema.sql` and created on first profile use for
existing databases (the application database role needs CREATE permission).
`/api/auth/password` verifies the current password, saves a bcrypt hash and
revokes other login sessions while keeping the current session signed in.

Run `npm run test:account` for account settings and isolation regression checks.

### Clinic access and durable saves

Clinic APIs require a verified session (the `sid` cookie or Bearer token). Owners receive only their own patient data; veterinarians receive their assigned appointments and those patients’ histories. Reception handles registration, intake, scheduling and payment. Administrators have read-only clinical oversight; staff invitations remain administrator-only. Clinical finalization requires an assigned visit in consultation and commits the note, optional vaccine and visit completion together.

The application no longer uses demo/in-memory saves when the API fails. A failed request leaves the form open for correction/retry. The legacy instant-approval `/api/owner/pets` route is retired: use pending pet registration requests. Account edits use `/api/auth/profile/contact`. Client-supplied audit identities and manual audit-log inserts are not accepted.

For existing databases, apply the idempotent checkout `ALTER TABLE appointments` block at the end of `server/database/schema.sql` before deployment (do not rerun demo seeding on a live database). Checkout also initializes these missing columns on first use and therefore requires `ALTER` permission if the migration was not applied. Checkout stores the discount, payment reference, cash received and change in `payment_details`; entering a reference records staff confirmation and does not independently verify a provider transfer.

Run clinic regressions with `npm run test:clinic`.

### Booking availability and vaccination automation

Apply `server/database/scheduling.sql` once to existing databases (after
`schema.sql`), using the database migration role. `npm run db:init` includes it
for new local databases. Booking/reminder endpoints also attempt the same
idempotent migration; a runtime role without DDL permissions requires the
migration to be applied first. It adds service, duration, arrival type and notes,
plus the persisted reminder queue and worker health table. No appointments or
vaccination dates are rewritten by this migration.

Bookings use **Asia/Manila**, 08:00–17:00, 30-minute start intervals, the existing
Philippine holiday closure calendar, and a rolling **90-day** window. Service
lengths are in `src/booking.js`: vaccination/deworming 30 minutes, consultation
and grooming 60, surgery/dental assessment 120. Reception confirms procedural
preparation and suitability. Both booking forms request the server's open times;
owners receive slot strings only. Server transactions serialize reservation
checks and writes, including edits, to reject overlapping visits and duplicate
pet/day bookings. Legacy AM/PM times remain supported and legacy visits without
service metadata occupy 30 minutes. Unknown legacy time formats close availability
for that day until reception corrects them. Walk-ins are reception arrivals with
measured intake afterward; they enter the queue without reserving a future slot.
Pet approval no longer silently reserves a fixed doctor/time. Annual one-off
holiday dates still need maintenance in the shared holiday table.

The reminder worker uses the **latest administered, veterinarian-certified dose**
for each pet/vaccine family. Uncertified protocol suggestions do not trigger
messages. A newer dose replaces the older recall schedule, including when the
new dose has no next date. Milestones are **30, 14 and 3 days** before the approved
booster date, at **09:00 Manila**, by email and TextBee SMS. Future jobs are stored
in PostgreSQL with unique milestone/channel keys. Missed runs catch up within
the current milestone window; a milestone before the record existed is not sent
retroactively. Old pending jobs expire at the next milestone or due date.

For a persistent Node deployment, supervise `npm run reminders:worker` separately
from the web process. It checks every five minutes; `npm run reminders:once`
performs one bounded batch. For Vercel, the included daily 01:00 UTC cron calls
`GET /api/jobs/vaccination-reminders`; set a long random **CRON_SECRET** in Vercel
so its `Authorization: Bearer ...` header can be verified. Calls without it are
rejected. For faster retry recovery or larger queues, use an authenticated
external scheduler every five minutes (or increase the Vercel cron frequency on
a plan that supports it). Each invocation handles up to 500 messages within a
four-minute processing budget; monitor backlog and invoke again when needed.
The Vercel API function permits a 300-second duration.

Configure email with `BREVO_API_KEY` + `BREVO_SENDER_EMAIL`, or `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (port465 uses TLS). Configure SMS with
`TEXTBEE_API_KEY` (or `TEXTBEE_KEY`) + `TEXTBEE_DEVICE_ID`. Reminder sends never
count the development outbox as success. Known rejections retry with exponential
backoff (15, 30, 60, 120 minutes; maximum five attempts) on subsequent worker
runs. Timeouts, server errors and interrupted sends are marked **uncertain** and
require checking provider history before further contact; the providers do not
supply a shared idempotency guarantee. **Accepted** means the provider accepted
the request, not confirmed handset/inbox delivery. The front desk's automatic
reminder panel shows missing setup, stale workers, backlog, failures and uncertain
submissions. Contact the owner after checking the provider when manual follow-up
is needed. Owner contact edits are picked up at dispatch time.

Validation (no live provider messages):

```bash
npm run test:clinic
npm run test:scheduling
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pawcare npm run test:scheduling:postgres
npm run build
```

The PostgreSQL integration test requires a disposable local database and permission
to create/drop an isolated test schema. It checks concurrent reservations,
reminder claims, milestone creation, retries, supersession and crash recovery;
provider delivery is replaced with synthetic adapters.

### Durable consultation checkout

Apply `server/database/checkout-inbox.sql` to existing databases after
`schema.sql`, using the migration role. `npm run db:init` includes it for new
databases. Checkout endpoints also attempt this idempotent migration; apply it
before deployment when the runtime database role cannot run DDL.

Finalizing a consultation creates its reception task in the same transaction.
The front desk inbox recovers unpaid completed visits from earlier dates and
persists them across refreshes. New handoffs open checkout when reception is
idle; an open profile, intake form, invoice or receipt is kept on screen. Tasks
arriving during that work wait until the form closes. The inbox refreshes every
three seconds and shows failures with a retry action. No separate worker is
needed for checkout.

Opening an unpaid invoice reserves it for that receptionist and browser window
for five minutes, renewed every minute while open. Other receptionists can see
who is handling it. Closing releases the reservation; a disconnected or crashed
window recovers through expiry. A lost claim disables payment and offers retry
without clearing invoice entries. Payment and task completion commit together;
failed payments keep the invoice open and do not issue a receipt. Only assistants
can claim tasks or record payments. Existing payment integrations without a claim
remain supported when no active reservation exists; they cannot override one.

The PostgreSQL integration suite above also verifies checkout rollback,
prior-day recovery, competing receptionists, claim renewal/release/expiry,
failed-payment recovery and payment/task atomicity.

### Pet registration review and correction

Apply `server/database/pet-registration.sql` after `schema.sql` before deploying
with a runtime database role that cannot run DDL. `npm run db:init` includes it;
state/registration endpoints also attempt the idempotent migration. It adds
request photos, dental details and a review revision, and preserves dental
details on the approved pet. Existing requests start at revision zero.

Owners submit required pet details for reception review. The server validates
real birth dates before today (Asia/Manila, within 40 years), species, sex,
spay/neuter status, weight 0.05–120 kg with up to two decimal places, text lengths,
and bounded JPG/PNG/WEBP data. Photos chosen in the form are resized before
submission and remain with the approved pet. The same image checks apply to
later pet-picture changes. Registration weight/dental details are owner reports;
they do not replace measured clinical intake or a veterinarian examination.

Corrections use `PUT /api/pet-requests/:id` and return the same request to Pending;
resending a declined request clears its decline reason. The owner can hold up
to 10 pets/requests and up to 3 pending requests. Name and capacity checks serialize
per owner to prevent simultaneous submissions bypassing the limits. Owners can
withdraw pending/declined requests; approved patients remain clinic records.

Edits, approval and decline must include the latest integer `revision` from
state or the previous response. This tightens the earlier unversioned review
API: older clients must reload/use the updated form. A stale review returns 409
and requires reopening the request. Failed saves retain form entries. Creation,
correction, withdrawal and review audit writes commit with the related data;
failed approval never leaves a patient or vaccination schedule behind. Approval
preserves the existing rule that no appointment is reserved automatically.

Validate against a disposable local database (no provider messages):

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pawcare npm run test:registration:postgres
```

### Administrator governance

The administrator portal uses real account records for staff access and account
counts. Its overview guides review of locked staff, visits assigned to inactive
doctors, unfinished arrivals, unpaid completed visits and automatic reminder
exceptions. Reception performs booking, intake and payment; veterinarians author
clinical records. Admin calendar and clinical views remain read-only, and the
sales page provides financial review/printing without collection controls.

Apply `server/database/staff-access.sql` after `schema.sql` before deploying with
a runtime database role that cannot alter tables. `npm run db:init` includes it;
admin endpoints also attempt the idempotent migration. Existing accounts remain
active by default. Deactivation retains historical records and removes doctors
from new booking choices. Reception must reassign affected upcoming visits.

Staff access changes require a reason and the latest integer `revision` from
`GET /api/admin/staff`. Only veterinarian and assistant accounts are eligible;
admin/owner accounts cannot be changed here. Stale actions return 409. Access
changes and their audit entries commit together and revoke existing sessions.
Reactivation preserves account locks and verification requirements; unlocking
clears failed attempts and cooldowns, then requires a fresh sign-in.

Staff invitations permit only the vet/assistant roles. An admin can revoke an
unused invitation or issue a replacement. Invitation creation returns an
admin-only activation link and a delivery status, **not a login token**. Provider
acceptance is not proof of inbox delivery. Development outbox responses report
`not_sent`. Acceptance validates identity/mobile/password, locks and consumes the
invitation once, and creates a restricted OTP session atomically. After mobile
verification, staff sign in again. OTP values are never returned by setup.

The overview shows the latest 100 saved audit entries. System Audit Trail searches
all saved entries with pages of 50, including trusted staff access changes,
invitations and successful verified sign-ins. A sign-in session and its audit
entry commit together. This adds future sign-in history; it cannot reconstruct
older events that were never recorded.

Validate governance against an isolated schema in a disposable local database
(provider adapters are mocked, so no email/SMS is sent):

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pawcare npm run test:admin:postgres
```

### Fixed prices and continuity of care

Owners can browse Services & Prices. New invoices require catalog IDs and the
exact official names and unit prices; the server rejects custom or altered lines.
Quantity and the existing invoice discount remain available to reception. Paid
historical receipts retain their original amounts. Older unpaid custom invoices
must be rebuilt from the catalog before payment.

Configure additional fixed products using the server environment variable
`CLINIC_PRODUCTS_JSON`, a JSON array of `{id,name,category,price}`. IDs must start
with `product_` and contain lowercase letters, digits or underscores. Categories
are `Pet shampoo`, `Pet vitamins`, `Pet medicine`, and `Pet accessories`.
Prices must be positive PHP amounts with at most two decimals. Use the clinic's
approved product names, sizes and prices; none are invented by the application.
An absent array adds no products; invalid configuration fails closed. Restart the
API after configuration changes. The same catalog serves owners and checkout.

Apply `server/database/care-workflow.sql` to existing databases before deployment.
New database initialization includes it; endpoints also initialize it when DDL
permission is available. Follow-up/recheck status, target date and instructions
commit with the consultation. Owners and reception see follow-up cards; booking
still uses available slots and clinic confirmation. A target date is not a reserved
appointment or an automatic SMS reminder.

Veterinarians manage vaccination cards from their menu and certify doses through
SOAP finalization. Reception retains registration, read-only card access and
reminder coordination. Owner booking derives its reason from the selected service;
optional notes retain symptoms and special requests.

An assigned veterinarian can hand an active arrival to another active veterinarian
with required instructions. Transfer, note and audit commit together, returning
the visit to Checked-in for the receiving vet. The recipient sees the patient
history and timestamped handoff chain; the former vet loses visit access unless
another assignment still grants patient-history access. Handoffs move an existing
arrival into the receiving queue; they do not reserve another appointment slot.

Regression checks: `node --test server/tests/care-workflow.test.js`,
`npm run test:clinic`, `npm run test:scheduling`, and the PostgreSQL scheduling
suite, which includes handoff and care-plan persistence tests.
