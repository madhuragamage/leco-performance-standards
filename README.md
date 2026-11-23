# LECO Performance Standards

This application manages LECO customer services against the Distribution Performance Standards Regulations, and monitors each service as it runs. It is based on the *Draft Report on Performance Monitoring Schemes – LECO Customer Services* (22 Jul 2020).

Each customer service is a workflow of time-stamped steps (the "Date 1, Date 2 …" in the report). Some steps start or stop an **SLA clock**. Each clock is checked against two targets: the LECO internal target and the PUCSL regulatory target. When a regulatory target is breached, the compensation owed to the customer is calculated automatically.

Customer applications come in from the **online customer application portal** through a REST intake API. Applications made at the counter or by phone are entered in the web app.

## What phase 1 covers

| Report section | In the app |
|---|---|
| 1.1–1.2 Services & regulatory targets | 9 services, 13 SLA clocks ([server/src/domain/catalog.ts](server/src/domain/catalog.ts)) |
| 1.3 Penalty scheme | Compensation rules per clock and nature of supply, capped, with per-affected-customer rules for outages |
| 1.4.1 LISS formats R1–R7 | Reports → LISS formats, as a monthly CSV ready for PUCSL |
| 1.5.1 Feeder class | Set per CSC (seeded from the report, editable in Admin) |
| 1.5.2 Changes required to distribution system | Captured at inspection; selects Threshold x1 or x2 |
| 1.5.3 Nature of supply | LV Retail / LV Bulk / MV Bulk; LV / HV Network for outages and pole/line shifting |
| 1.5.4 Reasons for not meeting the target | Required when a step stops a clock late; more than one reason can be chosen |
| 1.5.5 Two-stage thresholds | LECO internal (11/12) and regulatory (21/22), set per clock, nature of supply, changes required and feeder class |
| 1.5.6–1.5.7 Conformity / wayleave | Time between a non-conformity or wayleave notice and its close-out is excluded from the clock ("amended target") |
| 2–11 Key steps, KPIs, pending monitoring | Step-by-step workflow with role checks, the KPI tables, and the Pending services screen |
| 2.1 Estimate approval authority | Defaults: CSS ≤ 20k, BM ≤ 500k, SDM ≤ 2.5M, HEng ≤ 5M, GM above that. The administrator can change them in Targets & setup → Approval limits |
| Work allocation | Requests can be assigned to a person. **My tasks** lists, in priority order, what each user should do next, and the sidebar counter turns red when something is urgent |
| Service quality | Dashboard tiles show the share of measures within the LECO target, per service category, month to date and year to date |

Section 12 (SAIDI/SAIFI/EENS and individual supply-quality compensation) is **phase 2**.

## Running it

Prerequisites: Node 22+ and Docker Desktop.

```powershell
npm install
copy server\.env.example server\.env      # then change the secrets
npm run setup:demo                         # Postgres in Docker, schema, reference data, ~90 days of demo data
npm run dev                                # API on :4000, web on http://localhost:5173
```

Use `npm run setup` instead of `setup:demo` to load reference data and users only, with no demo requests.

Production: run `npm run build`, then `npm -w server start`. The API serves the built web client from `web/dist`. You must set `JWT_SECRET`, `PORTAL_API_KEY` and `DATABASE_URL`.

Tests: `npm test` runs the SLA engine tests (working days, exclusions, threshold selection, compensation, workflow rules).

### Seeded accounts

Every account gets the password `ChangeMe@123`, or `SEED_PASSWORD` if you set it. Change these before going live.

| Username | Role | Scope |
|---|---|---|
| admin | System administrator | All |
| gm, heng, sdm, ce | GM / Head of Engineering / SDM / Control Engineer | All |
| bm.moratuwa, be.moratuwa, ba.moratuwa | BM / BE / BA | Moratuwa branch |
| css.mrn, to.mrn, clerk.mrn, tech.mrn, agent.mrn | CSS / TO / Clerk / Technician / Agent | Moratuwa North CSC |

Clerks, customer service agents and Technical Officers can lodge new requests. A request lodged by a TO is recorded with the source *field*. Users see only their own CSC or branch. GM, HEng, SDM, CE and admin see everything.

## Portal intake API

All intake calls need the header `X-API-Key: <PORTAL_API_KEY>`.

**Create an application.** This call is idempotent on `portalReference`: a retry returns `200` with `duplicate: true`.

```http
POST /api/intake/applications
{
  "portalReference": "WEB-2026-000123",
  "serviceType": "NEW_CONNECTION",          // see list below
  "cscCode": "MRN",                          // CSC code or name
  "submittedAt": "2026-11-20T09:15:00+05:30",
  "customer": { "name": "...", "nic": "...", "mobile": "...", "email": "...", "address": "...", "accountNo": "..." },
  "natureOfSupply": "LV_RETAIL",             // optional: LV_RETAIL | LV_BULK | MV_BULK
  "subType": null,                           // e.g. METER/POLE/LINE/SERVICE_WIRE for SHIFTING
  "expectedServiceDate": "2026-12-01",       // optional, used for "customer happiness"
  "details": { }                             // anything else the portal wants kept
}
→ 201 { "requestId": 412, "refNo": "NC/MRN/2026/000412", "status": "OPEN", "duplicate": false }
```

`serviceType` is one of: `NEW_CONNECTION`, `RECONNECTION`, `METER_TESTING`, `SHIFTING`, `BILLING_INQUIRY`, `BREAKDOWN`, `NAME_TARIFF_CHANGE`, `OTHER_INQUIRY`. For `RECONNECTION`, `submittedAt` is the payment time, because that is when the clock starts.

**Report customer-side steps.** Only `PAYMENT` and `CONFORMITY_RECEIVED` are accepted. A conformity call must list the non-conformity codes the customer has rectified in `items`. Each code must be one that is still pending.

```http
POST /api/intake/applications/{portalReference}/events
{ "stepKey": "PAYMENT", "occurredAt": "2026-11-25T10:00:00+05:30", "data": { "receiptNo": "R-889", "amount": 45200 } }
{ "stepKey": "CONFORMITY_RECEIVED", "occurredAt": "2026-11-26T09:00:00+05:30", "items": ["NC03"] }
```

**Customer progress, for a "track my application" page.** The response includes `pendingNonConformities`, which lists each item with its code and description, so the portal can show the customer what still needs fixing.

```http
GET /api/intake/applications/{portalReference}
```

**Customer rating:**

```http
POST /api/intake/applications/{portalReference}/feedback   { "rating": 4, "comment": "..." }
```

**Scheduled outages from ADMS:**

```http
POST /api/intake/outages
{ "externalReference": "ADMS-7781", "cscCode": "GAL", "publishedAt": "...", "scheduledFor": "...", "affectedCustomers": 240, "noticeType": "SMS", "natureOfSupply": "LV_NETWORK" }
```

Every intake call, successful or not, is written to the `IntakeLog` table so failures can be traced.

## How measures are calculated

- **Working days** count the local (Asia/Colombo) dates after the start date, up to and including the end date. Weekends and holidays in Admin → Holidays are skipped. A job finished the same day is 0. Friday to Monday is 1.
- **Non-conformity** is a Yes/No question on each site-visit step: the inspection, the pre-construction site check, and breakdown attendance. If the answer is No, the workflow moves straight to the next step. If it is Yes, the officer ticks every non-conformity found. The customer then conforms each one separately, and the work cannot move on until all of them are conformed. For reconnections and meter tests, the visit itself is the work, so the technician either completes it or records *Visit made – non-conformity found*.
- **Exclusions.** The clock pauses from the moment the first non-conformity is reported until the last one is conformed. The same applies from a wayleave notice until the wayleave is acquired, and from an objection until it is settled. While a pause is running, the request shows as *Awaiting customer*. Each request page has a register showing every item, when it was reported and when it was conformed.
- **Which target applies.** The most specific matching threshold row wins: nature of supply first, then changes required, then feeder class. Until inspection records "changes required", the stricter *No* target is used.
- **Compensation** = rate × each started unit (day or hour) beyond the regulatory target, capped at the maximum. For scheduled outages it is per affected customer, per day short of the 48-hour notice.
- When a clock stops, its result is saved as a snapshot (`ClockResult`). Reports and dashboards read these snapshots, so later target changes do not quietly rewrite history. To apply new targets to past cases, use Admin → Targets → *Re-evaluate closed measures*.

## My tasks: what appears and in what order

A request appears in a user's list in one of three ways:
- **Assigned to me:** it is assigned to them and they can record the next step.
- **Team queue:** nobody who can act on it is assigned, and their role can record the next step. Anyone eligible can click *Take it*.
- **Mine – waiting on others:** it is assigned to them, but the next step belongs to someone else, for example the estimate approver.

The list is sorted by the most urgent running SLA clock of each request:

| Priority | Meaning | Highlight |
|---|---|---|
| Regulatory breach | Regulatory target already exceeded; compensation is accruing | red |
| Regulatory due soon | LECO target exceeded, and the regulatory target falls due within the "soon" window | red |
| LECO target exceeded | Past the internal target, regulatory target still some way off | amber |
| Due soon | LECO target falls due within the "soon" window | amber |
| On track / No deadline | Nothing pressing | – |
| Awaiting customer | Paused for non-conformity, wayleave or an objection | blue |

The "soon" window is 1 working day, 2 days, 1 hour or 10 minutes, depending on the measure's unit. Within the same priority, assigned work comes before the team queue, and the request with the least time left comes first.

Requests can be assigned by an Admin, GM, HEng, SDM, BM, CSS, Clerk or BE. The assignee must be someone whose role works on that service, at that CSC or branch. Every assignment is kept in the request's history.

## Decisions to confirm

The report leaves some things open, and others are interpretations. Every value below can be edited in **Targets & setup** without code changes.

1. **Regulatory targets are mostly provisional.** PUCSL had not set base levels when the report was written. The seeded values come from the report's examples (section 1.5.5 estimate thresholds) and the "present regulatory commitments" (Supply Services Code 10/40 days, reconnection 2 days, outage notice 48 h). Meter testing, shifting, billing and breakdowns have **no regulatory target yet**, so no compensation is calculated for them.
2. **Placeholders not in the report** are marked "Placeholder" in the notes: shifting internal target, billing answer and rectify hours, breakdown restoration.
3. **Meter testing clock** runs from payment to *test started*, matching LISS R4's "Date of meter test started". An alternative is to end it at *customer updated*.
4. **Bulk meter testing compensation** is LKR 50/day, capped at 500, which is lower than LV. This is exactly as the report's table shows it; please check that it is not a typo.
5. **Breakdowns**: the 30-minute LECO target is applied to *attendance*. Regulatory "replacing cut-out fuses" is a working-day clock from complaint to restoration.
6. **Other complaints**: 14 days LECO target and 28 days regulatory, following the complaint-handling procedure in section 11. The acknowledgement clock uses 2 working days.
7. **Holidays**: only fixed-date holidays for 2026 are seeded. Poya and other variable holidays must be loaded each year.

## Project layout

```
server/
  prisma/schema.prisma        data model
  prisma/seed.ts              branches, CSCs & feeder classes, targets, compensation, reason codes, users, demo data
  src/domain/catalog.ts       service workflows: steps, SLA clocks, KPIs (report sections 2-11)
  src/domain/sla.ts           SLA engine: exclusions, threshold selection, compliance, compensation
  src/domain/workflow.ts      who may record which step, ordering, approval authority, field validation
  src/domain/time.ts          Sri Lanka working-day arithmetic
  src/services/               request lifecycle, dashboards/pending monitor, LISS & compensation reports
  src/routes/                 REST API (auth, requests, monitoring, admin, intake)
web/src/
  pages/                      Dashboard, Pending services, Requests, Request detail, Reports, Targets & setup
```

## Supply Quality (report section 12)

### Data
1. **Transformer register.** Each transformer (`tf_id`) is linked to a CSC, and the CSC decides the feeder class. The register also holds the number of consumers on each transformer. Consumer numbers are kept per month, and *average consumers* is the average of the monthly totals, the same way the report divides its 12-month sum by 12.
2. **Interruption data.** Consumer hours lost and consumer interruptions per transformer, per date and per category. It can be sent daily or for any interval. Sending the same date, transformer and category again replaces the earlier figure, so corrections never double-count.

| Category | Meaning | In LECO total |
|---|---|---|
| `11-LECO-F`, `11-LECO-P`, `11-LECO-M` | 11kV LECO faults, planned, momentary | yes (as in the report's tables) |
| `LV-LECO-F`, `LV-LECO-P` | LV LECO faults, planned | yes |
| `33-CEB-F`, `33-CEB-P`, `11-CEB-F`, `11-CEB-P` | CEB-related 33kV and 11kV faults and planned | no – reported separately |

**Upload page** (*Supply quality → Data upload*, for Admin, CE, HEng and SDM). CSV files are accepted in either layout:
- one row per category: `date, tf_id, category, consumer_hours, consumer_interruptions[, consumers]`;
- one column per category and measure, like the report's tables, e.g. `11-LECO-F-Cons.hrs` and `11-LECO-F-Cons.Interruptions`. Total columns are ignored, because totals are calculated.

Each file is checked first, and every problem is listed with its line number. Nothing is saved until **Import** is pressed. Any upload can be removed afterwards.

**Automated feed (ADMS):** send the header `X-API-Key: <PORTAL_API_KEY>` with these calls:
```http
POST /api/intake/supply/interruptions
{ "rows": [ { "date": "2026-11-20", "tfId": "BZ0001", "category": "11-LECO-F", "consumerHours": 450.5, "consumerInterruptions": 225, "consumers": 225 } ], "dryRun": false }

POST /api/intake/supply/transformers
{ "month": "2026-11", "rows": [ { "tfId": "BZ0001", "csc": "MRN", "consumers": 225, "name": "Rawatawatte" } ] }
```

### Indices
- SAIDI = consumer hours lost ÷ average consumers. SAIFI = consumer interruptions ÷ average consumers. MAIFI = 11kV momentary interruptions ÷ average consumers. The unit tests reproduce the report's 2018 Feeder Class 1 figures exactly (SAIDI 26.51, SAIFI 37.41).
- The *Supply quality* page shows:
  - SAIDI and SAIFI by feeder class and category, the same layout as section 12.1, switchable to the raw consumer hours and interruptions;
  - each feeder class against the approved level, with the period value annualised and shown as *on course*, *at risk* or *exceeded*;
  - CEB-related interruptions, a monthly trend, a CSC ranking, and the transformers with the longest interruption duration compared with the specified individual hours (section 12.3).
- The approved levels (Targets & setup → Supply targets) are seeded from the report's example base data and marked provisional.

### Compensation (*Supply quality → Compensation*; GM, HEng, SDM, CE, Admin)
Compensation is calculated for each calendar year. While the year is in progress, two figures are shown:
- **as at today:** the indices so far, i.e. what would be payable if the year ended today;
- **projected:** the indices annualised to the full year.

| Section | Formula | Data needed |
|---|---|---|
| 12.1 Overall | C_SAIDI = (SAIDI − approved) × YearEnergy/8760 × SUPPLYCOST; C_SAIFI = (SAIFI − approved) × (SAIDI/SAIFI) × YearEnergy/8760 × SUPPLYCOST; C = max (zero when below the approved level) | approved SAIDI/SAIFI; energy sales and supply cost per feeder class |
| 12.2 EENS | (EENS − approved EENS) × CENS, i.e. (EENS/ETOT − approved/ETOT) × YearEnergy × CENS | `ens_kwh` in the interruption data; approved EENS (MWh) and CENS per feeder class |
| 12.3 Individual | (duration − specified hours) × group annual energy/8760 × SUPPLYCOST, per transformer group, shared among its customers by energy use | specified hours per feeder class; optional `annual_energy_kwh` per transformer (otherwise estimated pro rata to consumers) |

The unit tests reproduce the report's worked examples within a few rupees: the 2018 overall compensation (LKR 34,938,407.69, with SAIFI deciding FC1–3 and SAIDI deciding FC4) and the group examples (LKR 16,535.96, 9,732.88 and 2,691.48).

The base data for each year (Compensation page → *Base data*, editable by Admin) is seeded with the report's 2018 energy sales and a supply cost of 14.54. Replace these with the actual figures. EENS stays "not set" until the approved EENS and CENS are entered. The individual list can be exported as CSV, so billing can share each group's amount among its customers.

### Compensation by CSC
- **Commercial quality** (*Compensation by CSC*, for managers): the compensation payable on services completed in the period, plus what is still accruing on open services already past the regulatory target. It is broken down by CSC and service, and each CSC opens to its individual cases and the delay reasons recorded for them. These figures are exact, because each case belongs to a CSC.
- **Supply quality** (*Supply quality → Compensation by CSC*, for GM, HEng, SDM, CE, Admin and BM; a BM sees only their own CSCs):
  - **Overall:** the feeder-class amount is shared among its CSCs by each CSC's excess over the approved level on the index that decided the amount. That excess is consumer hours above the SAIDI allowance, or consumer interruptions above the SAIFI allowance. CSCs within the approved level carry no share.
  - **EENS:** shared by each CSC's energy not supplied above its consumer-weighted part of the approved EENS.
  - **Individual:** exact – each transformer belongs to a CSC.
  - The CSC shares add up to the company totals.

Demo data: `npx tsx prisma/seed-supply-demo.ts` creates `DEMO-` transformers and daily figures shaped on the report's 2018 indices. Remove them before going live with `npx tsx prisma/seed-supply-demo.ts --remove`.

## Phase 2 candidates

- Section 12: overall and individual supply quality (SAIDI/SAIFI/MAIFI/EENS by feeder class), transformer-level individual compensation, and the supply-quality LISS format, fed from ADMS outage data.
- Power quality voltage-measurement registers (section 1.4.3).
- SMS notifications to customers for non-conformity, estimates and decisions, through the LECO SMS gateway.
- Distribution energy-loss targets by CSC and branch.
- Single sign-on against LECO Active Directory.
