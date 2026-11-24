# Product Requirements Document
## Site Attendance and Weekly Payroll System

**Version:** 1.0 — review draft  
**Date:** November 17, 2026  
**Market:** Philippines  
**Currency / timezone:** PHP / Asia/Manila  
**Interfaces:** Admin/staff website and shared attendance app for phones/tablets

## 1. Product objective

Build a system where each work site has one attendance account. After that account logs in on a phone or tablet, the app displays only employees assigned to that site. Each employee selects their name, enters their own PIN, and records Clock In or Clock Out. Admin and authorized staff manage assignments, attendance, compensation, and weekly payroll through a website.

Payroll uses each employee's daily rate and an eight-hour normal working day. It includes overtime, undertime, applicable holiday pay, government deductions, allowances, cash advance repayments, paid leave, and payslips.

## 2. Confirmed requirements

| Area | Confirmed decision |
|---|---|
| Site login | One shared attendance account per site |
| Employee roster | Show employees assigned to the logged-in site only |
| Employee management | Admin or authorized staff creates employees and assigns sites |
| Attendance identity | Employee selects their name and enters a personal PIN |
| Attendance actions | Clock In and Clock Out; PIN required for both |
| Photos / biometrics | No selfie, fingerprint, or face recognition |
| Location | Capture device location when possible at attendance submission |
| Devices | Phones and tablets |
| Pay basis | Daily rate, stored per employee |
| Pay frequency | Weekly |
| Normal workday | Eight working hours; overtime and undertime supported |
| Country | Philippines |
| Payroll coverage | Government deductions, allowance, cash advance, paid leave, payslip, OT and holidays |
| Staff access | Authorized staff can view and edit salaries and payroll |

## 3. Decisions still needed

The PRD is usable for design and estimation. These settings remain open and must be resolved before production payroll is enabled.

| Decision | Status / proposed treatment |
|---|---|
| Weekly cutoff and payday | Awaiting owner input; configurable weekday, cutoff time, and payout offset |
| Overtime approval | Awaiting owner input; proposed: admin/staff reviews recorded OT before payroll finalization |
| Lunch break | Awaiting owner input: eight hours plus unpaid lunch, or eight hours including paid lunch |
| Work schedule | Confirm start/end times, working days, rest days, grace rules, and overnight work; eight hours alone is insufficient to identify lateness |
| Offline operation | Proposed first release: online attendance; no false success if disconnected; staff can enter a documented correction |
| Mobile platforms | Confirm Android only or Android and iOS; keep phone/tablet layouts platform-independent |
| Site/device scale | Confirm number of sites, employees per site, and simultaneous devices for capacity planning |
| Transfers | Proposed: one active site assignment at a time, with effective-dated transfers |
| Location failure | Proposed: save attendance with an exception flag for review; no geofence blocking in the first release |
| Leave and allowances | Confirm leave types, entitlements, accrual, carryover, and allowance eligibility/frequency |
| Deduction allocation | Confirm weekly collection schedule and month-end reconciliation treatment |
| Employment coverage | Confirm industry, employee classifications, site regions, and applicable wage/benefit rules |

Unresolved policy does not mean zero pay or zero deduction. Affected payroll lines remain flagged and cannot be finalized until resolved.

## 4. Roles and permissions

| Role | Access |
|---|---|
| Admin | All sites, employee records, salaries, staff permissions, policies, attendance, payroll, exports, and audit history |
| Authorized staff | Employee creation/assignment, PIN reset, attendance corrections, salaries, leave, advances, allowances, and payroll within assigned site scope |
| Site account | Roster and attendance submission for its own site; no access to salary, payroll, government IDs, employee PINs, or administrative actions |
| Employee | No individual app login; name selection and PIN authorize one attendance action only |

Admin/staff use individual website accounts so changes have an identifiable actor. Staff payroll authority is supported as requested; its site scope is assigned by the admin. PIN knowledge does not grant access to salary records.

## 5. Main workflows

### 5.1 Site setup

1. Admin creates the site, address, region, and optional map coordinates.
2. Admin creates its shared attendance credentials and configures applicable policies.
3. Admin/staff creates employee records, daily rates, schedules, and site assignments.
4. Admin/staff securely provisions individual employee PINs.
5. The site account logs in on a phone/tablet. The app shows the site name, connection state, and current roster.

### 5.2 Employee attendance

1. Employee searches for and selects their name. Display a short employee code to distinguish identical names.
2. Employee enters a masked PIN. The server verifies it against the selected employee and current site assignment.
3. With no open attendance session, show Clock In. With an open session, show Clock Out. Never toggle attendance automatically.
4. On explicit confirmation, capture the device's current location and submit the action.
5. Save the server timestamp, employee, site, device session, action, location status, and request identifier.
6. Show the employee's name, action, and saved time briefly, then clear the PIN and return to the roster.

An incorrect PIN creates no attendance record. A successful PIN check expires after the single action or a short inactivity timeout. The employee must re-enter the PIN for the next action.

### 5.3 Attendance review

Admin/staff sees daily attendance, open sessions, missing clock-outs, short workdays, extra hours, and location exceptions. Corrections require a reason and preserve original records. Site transfers cannot orphan an open session: close or resolve it first, or explicitly permit its closing action at the original site.

### 5.4 Weekly payroll

1. Select the weekly pay period and eligible employees/sites.
2. Resolve missing attendance, schedule conflicts, leave entries, and OT decisions.
3. Calculate earnings and deductions using the applicable dated rates and policies.
4. Review per-employee breakdowns, exception flags, and site totals.
5. Admin/authorized staff finalizes the payroll snapshot and generates payslips.
6. Record payment status and payment reference manually after actual payment.

Automatic computation does not automatically approve payroll or transfer money.

## 6. Functional requirements

### FR-01 — Site and employee management

- Create, update, deactivate, and search sites and employees without deleting historical payroll.
- Employee fields: employee ID, name, active status, hire date, employment classification, site assignment history, daily rate history, schedule, leave balances, allowance rules, and necessary government identifiers.
- Salary and assignment changes have effective dates. Historical payroll retains its original rate and site context.
- Use a stable employee ID throughout attendance, transfers, and payroll. Transfers must not create duplicate weekly pay or government deductions.
- Inactive employees cannot start a new attendance session. Deactivation with an open session requires staff resolution.

### FR-02 — PIN and site sessions

- Proposed PIN format: six numeric digits. PIN uniqueness is not required because the employee is selected first.
- Store only securely hashed PINs. Never show existing PINs to staff or record them in logs.
- Staff may reset a PIN, with audit history and secure handover; a reset invalidates any pending PIN authorization.
- Apply employee-level and device-level throttling. Proposed threshold: five failed attempts trigger temporary lockout and a staff-visible event.
- Site credentials and device sessions can be revoked. Changing site context requires a valid site login.
- Authorize site scope on the server for roster reads and attendance writes.

### FR-03 — Attendance integrity

- Use server time as authoritative for online attendance and display all payroll times in Philippine time.
- Allow only one open attendance session per employee, including across devices/sites.
- Reject duplicate Clock In and Clock Out without an open session, with a clear message.
- Repeated submission of the same request returns the original result instead of adding a second punch.
- Support shifts crossing midnight. Retain actual timestamps and allocate time to the appropriate date, holiday, and pay period rules.
- Do not auto-clock-out an employee after eight hours or infer an eight-hour workday from an incomplete record.
- Missing clock-out, overlapping leave/work, implausibly long sessions, or conflicting assignments require review before affected payroll finalization.
- Only Clock In/Out are required from employees. Unpaid break deductions therefore need an explicit approved break policy or documented staff correction.

### FR-04 — Location

- Request location permission and capture latitude, longitude, accuracy estimate, and capture time for each attendance action.
- Store states such as captured, permission denied, unavailable, timeout, or stale. Never silently reuse an old location as current.
- Display location and accuracy in the attendance detail view. Use a map link or map view available only to authorized personnel.
- Proposed behavior on failure: retain attendance and flag it for review; make the selected policy visible to the employee.
- Capture location only at the action, with no continuous background tracking.
- Location identifies the shared device's reported position. It does not independently prove which person entered the PIN. No geofence enforcement is part of the confirmed scope.

### FR-05 — Schedule, time, and leave

- Configure shifts, scheduled working days, rest days, break rules, and effective dates.
- Calculate payable regular time, lateness, undertime, and potential OT separately.
- Extra elapsed time is a review candidate; it is not automatically payable OT without applying the chosen work/approval policy.
- Admin/staff records leave on behalf of employees, approves it, and maintains a balance ledger.
- Paid leave credits eligible pay without requiring a clock-in. Unpaid leave does not create ordinary earnings.
- Prevent the same hours from being paid as worked time and paid leave twice. Leave pay and holiday eligibility require separate applicable rules.

### FR-06 — Payroll calculation

For an ordinary eight-hour day, define daily rate `D`, hourly rate `H = D / 8`, and minute rate `M = D / 480`.

```text
Worked minutes = valid clocked intervals - approved unpaid break minutes
Ordinary regular pay = payable ordinary regular minutes x M
OT pay = eligible OT hours x H x applicable OT multiplier
Gross pay = regular worked pay + worked-day premiums + OT pay
            + eligible unworked holiday pay + paid leave pay
            + allowances + approved earning adjustments
Net pay = gross pay - employee statutory contributions
          - withholding tax - authorized advance repayments
          - other authorized deductions
```

Regular payable minutes are capped at the normal eight-hour entitlement for an ordinary day; excess eligible work is handled as OT. Do not calculate one weekly total and use it to cancel short days against long days. The Labor Code separates undertime from overtime. [DOLE Labor Code, Book III](https://dole.gov.ph/book-3-conditions-of-employment/)

Use either reduced regular earnings for unpaid time or a full-day earning with a separate shortfall deduction; never both. The proposed display uses reduced earnings and an informational undertime line.

Use decimal arithmetic and a documented centavo rounding policy. Preserve minute-level quantities and unrounded calculation inputs. Rate changes inside a week apply to the affected work dates, not the whole week.

### FR-07 — Holidays, rest days, and overtime

For covered employees, the initial rule model includes the following common multipliers. They apply to the basic hourly rate; they are total rates, not extra amounts to add to another full payment.

| Day classification | First eight hours | OT hourly multiplier |
|---|---:|---:|
| Ordinary working day | 1.00 | 1.25 |
| Scheduled rest day | 1.30 | 1.69 |
| Special non-working day | 1.30 | 1.69 |
| Special non-working day + rest day | 1.50 | 1.95 |
| Regular holiday | 2.00 | 2.60 |
| Regular holiday + rest day | 2.60 | 3.38 |

Basis: [DOLE statutory monetary benefits handbook](https://nwpc.dole.gov.ph/wp-content/uploads/2024/11/Workers-Statutory-Monetary-Benefits-Handbook-2024-Edition.pdf).

Maintain national and local holiday calendars by year and site, with an official source and publication/effective dates. Treat special working days separately. Eligible unworked regular holidays can still generate holiday pay; no clock-in must not automatically mean no pay. Eligibility must use the applicable rules, including preceding work/paid-leave conditions. [DOLE 2026 holiday pay advisory](https://www.dole.gov.ph/php_assets/uploads/2025/09/Labor-Advisory-No.-12-25-Payment-of-Wages-for-the-Regular-Holidays-Special-Non-Working-Days-and-Special-Working-Day-for-the-Year-2026.pdf)

Support higher contractual benefits through versioned policies. Double holidays and other unsupported combinations must produce an exception requiring a documented rule, never silently use an ordinary-day rate. If night work is in scope, configure applicable night differential before payroll launch for those employees; otherwise flag night hours for resolution.

If OT review is enabled, keep pending, accepted, and disputed minutes with reasons. A pending or disputed payment decision must not silently remove recorded hours or allow an unresolved affected payroll to finalize.

### FR-08 — Government deductions and withholding

- Support SSS, PhilHealth, Pag-IBIG, and applicable BIR withholding, with employee classification, effective dates, bases, brackets, caps, and employee/employer shares stored separately.
- Use each agency's required contribution base; do not assume weekly gross is the correct base for every deduction.
- SSS uses its applicable contribution schedule and monthly salary credits. Employer contributions and employer-only EC must not reduce employee net pay. [SSS contribution guidance](https://www.sss.gov.ph/pay-contribution)
- PhilHealth's referenced advisory distinguishes monthly basic salary from OT, allowances, and deductions for undertime/absence. Preserve this distinct basis. [PhilHealth Advisory 2025-0002](https://www.philhealth.gov.ph/advisories/2025/PA2025-0002.pdf)
- Maintain Pag-IBIG contribution rules from effective official circulars. [Pag-IBIG member-service circulars](https://www.pagibigfund.gov.ph/about_publication_circulars_memberservices.html)
- Apply the appropriate weekly withholding schedule, taxable/exempt classifications, and year-end reconciliation inputs. [BIR withholding tables effective 2023 onward](https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf)

Weekly payroll must have a monthly contribution ledger. Allocate collections across the configured pay runs, track what has already been withheld, and reconcile to the actual monthly obligation. Handle four/five-payday months, joining/leaving mid-month, weeks spanning months, and site transfers. Never divide every monthly obligation by four as a universal rule.

Keep agency bases, projected/final liability, collected amounts, refunds/adjustments, and employer shares auditable. A payroll release requires an approved effective rule version for its period. The referenced publications are implementation sources, not a claim that every listed publication is the newest rule at deployment.

### FR-09 — Allowances and cash advances

- Configure allowance amount, eligibility, taxable treatment, frequency, and whether tied to days actually worked.
- Record advance principal, release date, authorization, installment schedule, repayments, adjustments, and outstanding balance.
- Do not deduct more than the outstanding balance or process the same repayment twice when payroll is recalculated.
- Insufficient net pay creates a review exception; any deferred installment remains in the advance ledger.
- Manual adjustments require a reason and a named actor.

### FR-10 — Payroll lifecycle and payslips

- Payroll states: Draft → Ready for Review → Finalized → Paid. Finalization requires all blocking exceptions resolved.
- A finalized run is an immutable snapshot of attendance, rates, rules, earnings, deductions, and approval actor/time.
- Correct finalized payroll through a linked adjustment or authorized void/reissue workflow with history; never overwrite a paid payslip silently.
- Payslip includes employee, site, dates, daily/hourly rate, regular time, OT, holiday/rest-day premiums, leave pay, allowances, itemized deductions, gross, net, and payment status.
- Provide individual printable/downloadable payslips and payroll-register exports through the website. Staff distributes them privately; no public payslip list on the shared kiosk.
- Payment recording and government contribution reports are included. Bank transfers, statutory filing, and actual remittance integrations are outside the first release.

## 7. Screens

| Interface | Screens |
|---|---|
| Attendance app | Site login; site roster/search; employee/PIN; Clock In/Out confirmation; success/error; location permission/exception; session/logout |
| Admin/staff website | Dashboard; sites/device sessions; employees/assignments/rates; schedules; attendance/detail/corrections; OT review; leave; allowances; cash advances; payroll preview/detail/finalization; payslips; reports; policies; users/access; audit log |

The attendance app should use large touch targets, a numeric PIN keypad, clear connection status, and short Filipino/English labels. Salary and government identifiers must never appear in roster search results.

## 8. Core records

Site; Site Account; Device Session; Admin/Staff User; Employee; Site Assignment History; Rate History; Schedule; Holiday; PIN Credential; Attendance Event; Work Session; Location Observation; Attendance Correction; OT Decision; Leave Ledger; Allowance Rule; Advance Ledger; Statutory Rule Version; Monthly Contribution Ledger; Payroll Period; Payroll Run; Payroll Line; Payslip; Payment Record; Audit Event.

Attendance events are original evidence. Corrections and payroll results link to them rather than replacing them. Each payroll line stores quantity, rate, multiplier, amount, and source references so staff can explain every peso.

## 9. Quality and operational requirements

- Proposed usability target: completing attendance in 15 seconds after finding the employee, under normal connectivity and location availability.
- Proposed response target: save and confirm within three seconds after receiving location or reaching its configured timeout, under agreed production load.
- Encrypt traffic and stored sensitive data; restrict exports and audit privileged access.
- Establish configurable record retention and backup/restore procedures before launch. Location retention should be separately configurable from payroll retention.
- Show a clear attendance/location notice on the shared app. Never collect data unrelated to the attendance action.
- Backups must be tested by restoring a sample dataset. Sensitive credentials must not appear in application logs.
- Monitor failed punches, duplicate submissions, lockouts, unresolved sessions, payroll exceptions, and failed exports.
- Expected employee/device counts and supported OS versions must be agreed before load and device compatibility sign-off.

## 10. Acceptance criteria

| ID | Scenario | Expected result |
|---|---|---|
| AC-01 | Site A logs in | Only Site A's active assigned roster is returned, including by direct API requests |
| AC-02 | Staff assigns or transfers an employee | Roster changes at the effective time; prior attendance/payroll remains traceable |
| AC-03 | Employee submits wrong PIN | No attendance saved; failed-attempt policy applied |
| AC-04 | Employee clocks in/out with correct PIN | One event saved with employee, site, authoritative time, and location status |
| AC-05 | Two devices submit Clock In simultaneously | Only one open session; duplicate/retry receives a clear result |
| AC-06 | Location permission denied | Proposed policy saves attendance with an exception; no fabricated coordinates |
| AC-07 | Network fails during submission | App does not claim success; retry checks the original request to prevent duplication |
| AC-08 | Clock Out is missing | Record flagged; no automatic eight-hour pay; affected payroll cannot finalize |
| AC-09 | Daily rate PHP 800, eight payable ordinary hours | Regular earnings PHP 800 before deductions |
| AC-10 | Same rate, seven payable ordinary hours | Regular earnings PHP 700; no additional PHP 100 undertime deduction |
| AC-11 | Same rate, eight regular hours plus two eligible ordinary OT hours | PHP 800 regular + PHP 250 OT = PHP 1,050 before deductions |
| AC-12 | Same rate, eight hours on a covered regular holiday | Total worked holiday earnings PHP 1,600, without adding another PHP 800 basic payment |
| AC-13 | Five ordinary eight-hour days plus two ordinary OT hours at PHP 800/day | PHP 4,000 regular + PHP 250 OT = PHP 4,250 before other earnings/deductions |
| AC-14 | Eligible paid leave without punches | Leave pay added and leave balance updated; no absence deduction for the same hours |
| AC-15 | Approved monthly deduction fixture with five weekly paydays | Allocations reconcile exactly to monthly obligation without duplicate collection |
| AC-16 | Recalculate a payroll containing an advance repayment | No second ledger repayment; outstanding balance changes once on posting |
| AC-17 | Salary changes mid-week or employee transfers | Correct effective rate per work date; one consolidated employee contribution ledger |
| AC-18 | Finalized payroll receives an attendance correction | Original payslip preserved; linked adjustment/reissue required |
| AC-19 | Shift crosses midnight/holiday/cutoff | Hours allocated by applicable dated rules with no duplication or missing minutes |
| AC-20 | Shared site user attempts salary/export access | Request denied; employee PIN cannot unlock administrative privileges |

Numbers above are calculation fixtures, not recommended employee wage rates. Ordinary OT and holiday fixtures assume the employee is covered by the cited rules. Agency deductions need approved fixtures for their own bases, brackets, exemptions, caps, and effective dates.

## 11. Delivery scope and release gates

**Milestone 1 — Site attendance:** Site accounts, employee assignment, secure PINs, phone/tablet UI, location status, reliable Clock In/Out, attendance review and corrections.

**Milestone 2 — Weekly payroll:** Schedules, daily rates, regular/OT/undertime calculations, holiday calendar, leave, allowances, advances, statutory rules, weekly/monthly reconciliation, payslips and exports.

**Milestone 3 — Pilot and release:** Exercise acceptance scenarios with representative site data; compare at least two weekly runs against independently reviewed payroll; validate month-end/five-payday fixtures; test access isolation, device behavior, and backup restore.

Release requires the open business settings in Section 3 to be resolved for the pilot workforce, applicable government rules loaded and reviewed, no unexplained payroll differences, and blocking attendance exceptions cleared.

**Outside initial scope:** Selfies, fingerprint/face recognition, employee personal accounts, continuous GPS tracking, geofence restrictions, offline synchronization unless selected, automated bank payouts, automatic statutory filings, recruitment, and performance management. Annual bonus/13th-month processing is not specified by this weekly-payroll PRD; retain the earnings history needed for it and confirm whether to add a separate module.
