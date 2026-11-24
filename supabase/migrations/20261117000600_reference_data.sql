-- =============================================================================
-- Migration 6: reference data
--
-- IMPORTANT: statutory rule versions are inserted as DRAFT. Payroll that uses a
-- draft rule shows a blocking exception and cannot be finalized until an admin
-- verifies the parameters against the current official issuances and approves
-- them (Policies → Statutory rules). Holidays must likewise be verified against
-- the official proclamation for each year before payroll use.
-- =============================================================================

-- Day classification multipliers (total rate on the basic rate), PRD FR-07.
insert into public.day_type_multipliers (day_type, effective_from, regular_multiplier, ot_multiplier, source_reference) values
  ('ordinary',             '2000-01-01', 1.00, 1.25, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)'),
  ('rest_day',             '2000-01-01', 1.30, 1.69, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)'),
  ('special_non_working',  '2000-01-01', 1.30, 1.69, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)'),
  ('special_rest',         '2000-01-01', 1.50, 1.95, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)'),
  ('regular_holiday',      '2000-01-01', 2.00, 2.60, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)'),
  ('regular_holiday_rest', '2000-01-01', 2.60, 3.38, 'DOLE Handbook on Workers'' Statutory Monetary Benefits (2024 ed.)');

-- Leave types (entitlements / accrual are an open PRD decision; adjust as agreed).
insert into public.leave_types (code, name, is_paid, requires_balance, annual_entitlement_days) values
  ('SIL',  'Service Incentive Leave', true,  true,  5),
  ('SL',   'Sick Leave',              true,  true,  0),
  ('LWOP', 'Leave Without Pay',       false, false, 0);

-- Example schedules covering the open lunch-break decision (PRD §3).
insert into public.schedules (name, start_time, end_time, working_days, unpaid_break_minutes, break_applies_after_minutes, grace_minutes, notes) values
  ('Day 08:00-17:00 Mon-Sat (1h unpaid lunch)', '08:00', '17:00', '{1,2,3,4,5,6}', 60, 300, 5,
   'Eight paid hours plus a one-hour unpaid lunch.'),
  ('Day 08:00-16:00 Mon-Sat (paid lunch)',      '08:00', '16:00', '{1,2,3,4,5,6}', 0, 300, 5,
   'Eight hours including a paid meal period.');

-- Statutory rule versions (DRAFT — verify and approve before use).
insert into public.statutory_rule_versions (agency, name, effective_from, status, params, source_reference, notes) values
  ('sss', 'SSS contribution schedule 2025 (15%)', '2025-01-01', 'draft',
   '{"basis": "compensation", "employee_rate": 0.05, "employer_rate": 0.10,
     "msc_min": 5000, "msc_max": 35000, "msc_step": 500,
     "ec_threshold": 15000, "ec_low": 10, "ec_high": 30}',
   'SSS contribution schedule effective January 2025 — https://www.sss.gov.ph/pay-contribution',
   'MSC = nearest 500 step (5,000–35,000). EE 5%, ER 10% incl. MPF; EC ₱10 below ₱15,000 MSC, else ₱30. Verify before approving.'),
  ('philhealth', 'PhilHealth premium 5% (2025)', '2025-01-01', 'draft',
   '{"basis": "basic", "rate": 0.05, "employee_share": 0.5, "floor": 10000, "ceiling": 100000}',
   'PhilHealth Advisory 2025-0002 — https://www.philhealth.gov.ph/advisories/2025/PA2025-0002.pdf',
   'Basis is monthly basic salary (excludes OT and allowances). Shared equally. Verify before approving.'),
  ('pagibig', 'Pag-IBIG contribution (₱10,000 max fund salary)', '2024-02-01', 'draft',
   '{"basis": "basic", "employee_rate": 0.02, "employee_rate_low": 0.01, "low_threshold": 1500,
     "employer_rate": 0.02, "max_fund_salary": 10000}',
   'Pag-IBIG Fund member-service circulars — https://www.pagibigfund.gov.ph/about_publication_circulars_memberservices.html',
   'EE 1% if monthly compensation ≤ ₱1,500 else 2%; ER 2%; capped at ₱10,000 fund salary. Confirm the compensation basis.'),
  ('bir_withholding', 'BIR weekly withholding table (2023 onward)', '2023-01-01', 'draft',
   '{"period": "weekly", "brackets": [
      {"over": 0,      "base": 0,        "rate": 0},
      {"over": 4808,   "base": 0,        "rate": 0.15},
      {"over": 7692,   "base": 432.60,   "rate": 0.20},
      {"over": 15385,  "base": 1971.20,  "rate": 0.25},
      {"over": 38462,  "base": 7740.45,  "rate": 0.30},
      {"over": 153846, "base": 42355.65, "rate": 0.35}]}',
   'RR 11-2018 Annex E (withholding tax table effective January 1, 2023) — https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf',
   'Weekly table. Taxable = taxable earnings − employee SSS/PhilHealth/Pag-IBIG. Minimum wage earners: only non-exempt extras are taxed.');

-- 2026 national holidays (verify against the official proclamation; add Eid''l Fitr /
-- Eid''l Adha when proclaimed, and local holidays per site).
insert into public.holidays (holiday_date, name, kind, source_reference, notes) values
  ('2026-01-01', 'New Year''s Day',                     'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-04-02', 'Maundy Thursday',                     'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-04-03', 'Good Friday',                         'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-04-09', 'Araw ng Kagitingan',                  'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-05-01', 'Labor Day',                           'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-06-12', 'Independence Day',                    'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-08-31', 'National Heroes Day',                 'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-11-30', 'Bonifacio Day',                       'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-12-25', 'Christmas Day',                       'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-12-30', 'Rizal Day',                           'regular',             'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-02-17', 'Chinese New Year',                    'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-04-04', 'Black Saturday',                      'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-08-21', 'Ninoy Aquino Day',                    'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-11-01', 'All Saints'' Day',                    'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-11-02', 'All Souls'' Day',                     'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-12-08', 'Feast of the Immaculate Conception',  'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-12-24', 'Christmas Eve',                       'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-12-31', 'Last Day of the Year',                'special_non_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Verify'),
  ('2026-02-25', 'EDSA People Power Revolution Anniversary', 'special_working', 'DOLE Labor Advisory No. 12-25 (2026 holidays)', 'Special working day: ordinary pay rules');
