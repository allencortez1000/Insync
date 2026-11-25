# Insync — Site Attendance & Weekly Payroll

Implementation of [PRD-Attendance-Payroll.md](PRD-Attendance-Payroll.md) for the Philippines (PHP, Asia/Manila).

| Folder | What it is | Stack |
|---|---|---|
| [supabase/](supabase/) | Database, security, attendance API, payroll engine | Supabase Postgres (SQL migrations) |
| [admin/](admin/) | Admin / staff website | Vite + React 19 + TypeScript + Tailwind 4 + supabase-js |
| [app/](app/) | Shared site attendance app for phones and tablets | Expo SDK 54 (React Native 0.81) — matches Expo Go SDK 54 |

```
Phone/tablet (Expo, anon key) ──► site_* RPCs only (token-checked, security definer)
Website (Supabase Auth user)  ──► tables via row-level security + admin/payroll RPCs
                                   └─ Postgres: attendance evidence, payroll engine, ledgers, audit log
```

## 1. Database (Supabase)

1. Create a Supabase project.
2. Apply the migrations **in filename order**. Either:
   - Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`, or
   - paste each file from `supabase/migrations/` into the SQL editor and run it, oldest first.
3. **Auth → Providers → Email**: keep sign-ups enabled (new staff sign up and wait for approval) and turn on email confirmation.
4. Open the admin website, sign up with the owner's email, then run once in the SQL editor:
   ```sql
   select public.bootstrap_admin('owner@example.com');
   ```
5. In the website, under **Policies & rules**:
   - **Statutory rules**: the seeded SSS, PhilHealth, Pag-IBIG and BIR versions are **drafts**. Check each rate, bracket, cap and basis against the current official issuance, then approve it. Payroll that uses a draft cannot be finalized.
   - **Holidays**: check the seeded 2026 national holidays against the proclamation. Add Eid'l Fitr and Eid'l Adha when they are proclaimed, plus any local holidays per site.
   - **Settings**: record the owner's decisions (see §4), then click *Save & mark policies confirmed*.
6. Set up the operation: create **sites** (name + app password in the same form; the code is generated automatically) → add **employees** (rate, schedule, site) → **generate PINs** and hand them over privately. The attendance app signs in with the **site name** and that password.

### Tests

The acceptance suite runs the real migrations on PGlite (Postgres compiled to WASM) with a small Supabase shim. It needs no Docker or Supabase project.

```
cd supabase/tests && npm install && npm test
```

It covers AC-01 to AC-20: roster isolation, PIN lockout, idempotent punches, a single open session, location exceptions, transfers, RLS, the ₱800/₱700/₱1,050/₱1,600/₱4,250 fixtures, paid leave, five-payday monthly reconciliation, single-posting of advances, mid-week rate changes, and void and reissue after a correction.

Three more test layers live in [e2e/](e2e/) (`cd e2e && npm install`):

| Command | What it does | Writes data? |
|---|---|---|
| `npm.cmd run test:pg17` (from the root) | The same suite on a real, throw-away Postgres 17 with Supabase's default privileges, plus a lock-down audit (what the app's key can reach, tables without RLS, UPDATE/DELETE without WHERE) | No (local only) |
| `node ui-smoke.mjs` | Opens every page, tab and form of the website in Edge and reports failed requests and error boxes | No (read-only) |
| `node live-e2e.mjs` | The whole flow through the website and the app's API: site → employee → PIN → app sign-in → Clock In/Out → corrections → payroll → payslip → payment → reports → clean-up | **Yes** — a "ZZ Test Site" and test employee, voided / deactivated afterwards |

The last two need the website running (`npx vite --port 5199` in `admin/`) and `E2E_BASE`, `E2E_EMAIL`, `E2E_PASSWORD` set.

## 2. Admin website

The admin website and the web (PWA) version of the attendance app are served as **one website**: admin at `/`, attendance app at `/site`.

```
npm run install:all         # once
npm run dev                 # http://localhost:5173  (admin)  and  http://localhost:5173/site/  (attendance PWA)
npm run build:all           # production build of both into ./dist (admin at /, attendance PWA at /site)
```

On Windows PowerShell, if `npm` is blocked by the execution policy, use `npm.cmd` (for example `npm.cmd run dev`).

Supabase settings come from `admin/.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) or, if that file is missing, from the project-root `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Locally, `/site` serves the last `build:all` output; for live editing of the attendance app use `npm run dev:site` (http://localhost:8081/site/).

Deploy with Netlify using the root `netlify.toml` (it runs the combined build and publishes `dist`), or deploy `dist` to any static host with these fallbacks: `/site/*` → `/site/index.html`, everything else → `/index.html`. Use only the **anon / publishable** key; never put the `service_role` key in the website or the app.

Screens: Dashboard · Attendance (review, corrections, location detail) · Overtime review · Employees (assignments, transfers, rates, schedules, PINs, leave ledger) · Schedules · Leave · Allowances · Cash advances · Payroll runs (calculate → review → finalize → paid, exceptions, line-level breakdown, adjustments, void / reissue) · Payslips (printable / Save as PDF) · Reports (payroll register, monthly contributions, attendance, payments CSV) · Sites & devices · Policies & rules · Users & access · Audit log.

## 3. Attendance app

```
cd app
copy .env.example .env      # EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY
npm install
npx expo start              # works in Expo Go
```

For store or kiosk installs, build with EAS (`npx eas-cli@latest build`) after changing the placeholder bundle IDs in `app/app.json`. See [app/README.md](app/README.md) for app behaviour.

## 4. Open PRD decisions — defaults used (all changeable)

| PRD §3 decision | Default in this build | Where to change |
|---|---|---|
| Weekly cutoff / payday | Monday–Sunday period, payday the following Friday | Policies → Settings |
| OT approval | Extra time beyond 8 worked hours needs an OT decision; pending or disputed OT blocks finalization | Settings / Overtime review |
| Lunch break | Per schedule. Two seeded examples: 1 h unpaid lunch, or paid lunch | Schedules |
| Work schedule | Required per employee. Payroll flags employees without one | Employees → Rate & schedule |
| Night work | Flagged as blocking until night differential is enabled (10% default) | Settings |
| Offline | Online only. The app never claims success while offline, and retries reuse the same request id | — |
| Transfers | One active assignment, effective-dated. An open session must be closed first, or closing at the original site must be permitted | Employee → Site & PIN |
| Location failure | Attendance is saved and flagged for review. Optionally *block* | Settings |
| Leave / allowances | SIL (5 days), SL, LWOP seeded. Allowances per day worked or per week, taxable flag | Leave types / Allowances |
| Deduction allocation | Monthly obligation projected per payday; the last payday of the month trues up exactly | Statutory rules |

## 5. How payroll is calculated (summary)

**Default: Construction computation** (from `Construction_Computations_Only.pdf`, migration 10; switch in Policies → Settings):
lunch 1 h when gross ≥ 8 h · worked = whole hours · regular = min(worked, 8) · OT = gross − 9 h (automatic) ·
Sunday = rest day at R2(D × 1.30) · OT rate R2(D ÷ 8 × 1.25) · rest-day OT R2(R2(rest rate ÷ 8) × 1.30) ·
holiday pay entered manually (payroll adjustment "Holiday pay") · deductions from each employee's Deductions tab
(SSS, PhilHealth, Pag-IBIG, tax, SSS loan, additional) + cash advances, capped so net ≥ 0.

**Alternative: DOLE statutory engine:**

- `M = daily rate ÷ 480`. Punches are truncated to the minute and split at midnight and at 10 PM / 6 AM, so each minute is classified by its own date (holiday, rest day) and whether it is night time.
- The first 480 worked minutes of a work date are regular time. The rest is an OT candidate. Days are never netted across the week; undertime is informational only.
- Multipliers are total rates (DOLE baseline): ordinary 100% / OT 125%, rest day or special day 130% / 169%, special day + rest day 150% / 195%, regular holiday 200% / 260%, regular holiday + rest day 260% / 338%.
- An eligible regular holiday pays 100% for any unworked balance of the 8 hours. Eligibility = present or on paid leave on the nearest preceding scheduled working day.
- SSS, PhilHealth and Pag-IBIG are reconciled by payday month through the contribution ledger. BIR withholding uses the weekly table on taxable pay minus employee contributions; minimum wage earners are exempt.
- Cash advances and contributions are posted to their ledgers **only when payroll is finalized**, so recalculating never double-posts. Finalized runs and payslips are immutable. Corrections after finalization are listed as impacts and handled by void → reissue.

## 6. Security model

- The site account (app) can only call the seven `site_*` functions. It has no table access and no salary, payroll, ID or PIN data.
- PINs, site passwords and device tokens are stored only as bcrypt or SHA-256 hashes, and those columns are not readable through the API.
- Staff see only their assigned sites (`staff_site_scopes`). Admins see everything. The audit log is admin-only and strips secrets.
- Attendance events are immutable evidence. Corrections need a reason and are logged with the actor.
- **If you add migrations later**, end them with the same function lockdown as `20261117000700_lockdown.sql`.

## 7. Not done / still to verify

- Statutory parameters and 2026 holidays are seeded as drafts for verification. They are not a claim that they are the newest rules.
- Not yet exercised against a live Supabase project, a real browser, or physical phones and tablets. Do a pilot (PRD Milestone 3) with representative data before production. Compare at least two weekly runs with independently reviewed payroll.
- Outside the PRD's initial scope: offline sync, bank payouts, statutory e-filing, 13th-month pay, and selfies or biometrics.
- Load and device sizing needs the site, employee and device counts from PRD §3.
