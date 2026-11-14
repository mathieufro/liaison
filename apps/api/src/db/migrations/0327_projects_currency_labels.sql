-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Currencies on billing terms and cost rates: stored as ISO 4217 codes only,
-- and time costed at a rate with no currency is told apart.
--
-- Earlier writers stored a currency as typed (blank, lower case) or cut it to
-- three characters, a leading space included. Each value is trimmed and
-- upper-cased; one that is still not an ISO 4217 code becomes null, which the
-- readers treat as "no currency set", so the figure asks for it again instead
-- of comparing a mistyped code. The list is the one the app's runtime knows
-- (Intl).
--
-- A rate with no currency says nothing about what its minor units are in, so a
-- project whose costed time comes partly from such a rate and partly from a
-- rate with a currency cannot be summed. project_time_cost_unlabelled answers
-- whether any costed time has no currency, under the same rule as
-- app_projects.project_time_cost_currencies: the org and the exact margin scope
-- are re-checked inside, and the answer is one boolean, never a person.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
UPDATE app_projects.project_billing_terms
   SET currency = upper(btrim(currency))
 WHERE currency IS NOT NULL AND currency <> upper(btrim(currency));
--> statement-breakpoint
UPDATE app_projects.project_billing_terms
   SET currency = NULL
 WHERE currency IS NOT NULL AND currency NOT IN (
    'ADP', 'AED', 'AFA', 'AFN', 'ALK', 'ALL', 'AMD', 'ANG', 'AOA', 'AOK', 'AON', 'AOR', 'ARA',
    'ARL', 'ARM', 'ARP', 'ARS', 'ATS', 'AUD', 'AWG', 'AZM', 'AZN', 'BAD', 'BAM', 'BAN', 'BBD',
    'BDT', 'BEC', 'BEF', 'BEL', 'BGL', 'BGM', 'BGN', 'BGO', 'BHD', 'BIF', 'BMD', 'BND', 'BOB',
    'BOL', 'BOP', 'BOV', 'BRB', 'BRC', 'BRE', 'BRL', 'BRN', 'BRR', 'BRZ', 'BSD', 'BTN', 'BUK',
    'BWP', 'BYB', 'BYN', 'BYR', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLE', 'CLF', 'CLP',
    'CNH', 'CNX', 'CNY', 'COP', 'COU', 'CRC', 'CSD', 'CSK', 'CUC', 'CUP', 'CVE', 'CYP', 'CZK',
    'DDM', 'DEM', 'DJF', 'DKK', 'DOP', 'DZD', 'ECS', 'ECV', 'EEK', 'EGP', 'ERN', 'ESA', 'ESB',
    'ESP', 'ETB', 'EUR', 'FIM', 'FJD', 'FKP', 'FRF', 'GBP', 'GEK', 'GEL', 'GHC', 'GHS', 'GIP',
    'GMD', 'GNF', 'GNS', 'GQE', 'GRD', 'GTQ', 'GWE', 'GWP', 'GYD', 'HKD', 'HNL', 'HRD', 'HRK',
    'HTG', 'HUF', 'IDR', 'IEP', 'ILP', 'ILR', 'ILS', 'INR', 'IQD', 'IRR', 'ISJ', 'ISK', 'ITL',
    'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRH', 'KRO', 'KRW', 'KWD', 'KYD',
    'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LTL', 'LTT', 'LUC', 'LUF', 'LUL', 'LVL', 'LVR',
    'LYD', 'MAD', 'MAF', 'MCF', 'MDC', 'MDL', 'MGA', 'MGF', 'MKD', 'MKN', 'MLF', 'MMK', 'MNT',
    'MOP', 'MRO', 'MRU', 'MTL', 'MTP', 'MUR', 'MVP', 'MVR', 'MWK', 'MXN', 'MXP', 'MXV', 'MYR',
    'MZE', 'MZM', 'MZN', 'NAD', 'NGN', 'NIC', 'NIO', 'NLG', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB',
    'PEI', 'PEN', 'PES', 'PGK', 'PHP', 'PKR', 'PLN', 'PLZ', 'PTE', 'PYG', 'QAR', 'RHD', 'ROL',
    'RON', 'RSD', 'RUB', 'RUR', 'RWF', 'SAR', 'SBD', 'SCR', 'SDD', 'SDG', 'SDP', 'SEK', 'SGD',
    'SHP', 'SIT', 'SKK', 'SLE', 'SLL', 'SOS', 'SRD', 'SRG', 'SSP', 'STD', 'STN', 'SUR', 'SVC',
    'SYP', 'SZL', 'THB', 'TJR', 'TJS', 'TMM', 'TMT', 'TND', 'TOP', 'TPE', 'TRL', 'TRY', 'TTD',
    'TWD', 'TZS', 'UAH', 'UAK', 'UGS', 'UGX', 'USD', 'USN', 'USS', 'UYI', 'UYP', 'UYU', 'UYW',
    'UZS', 'VEB', 'VED', 'VEF', 'VES', 'VND', 'VNN', 'VUV', 'WST', 'XAF', 'XAG', 'XAU', 'XBA',
    'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR', 'XEU', 'XFO', 'XFU', 'XOF', 'XPD', 'XPF', 'XPT',
    'XRE', 'XSU', 'XTS', 'XUA', 'XXX', 'YDD', 'YER', 'YUD', 'YUM', 'YUN', 'YUR', 'ZAL', 'ZAR',
    'ZMK', 'ZMW', 'ZRN', 'ZRZ', 'ZWD', 'ZWG', 'ZWL', 'ZWR'
 );
--> statement-breakpoint
UPDATE app_projects.cost_rates
   SET currency = upper(btrim(currency))
 WHERE currency IS NOT NULL AND currency <> upper(btrim(currency));
--> statement-breakpoint
UPDATE app_projects.cost_rates
   SET currency = NULL
 WHERE currency IS NOT NULL AND currency NOT IN (
    'ADP', 'AED', 'AFA', 'AFN', 'ALK', 'ALL', 'AMD', 'ANG', 'AOA', 'AOK', 'AON', 'AOR', 'ARA',
    'ARL', 'ARM', 'ARP', 'ARS', 'ATS', 'AUD', 'AWG', 'AZM', 'AZN', 'BAD', 'BAM', 'BAN', 'BBD',
    'BDT', 'BEC', 'BEF', 'BEL', 'BGL', 'BGM', 'BGN', 'BGO', 'BHD', 'BIF', 'BMD', 'BND', 'BOB',
    'BOL', 'BOP', 'BOV', 'BRB', 'BRC', 'BRE', 'BRL', 'BRN', 'BRR', 'BRZ', 'BSD', 'BTN', 'BUK',
    'BWP', 'BYB', 'BYN', 'BYR', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLE', 'CLF', 'CLP',
    'CNH', 'CNX', 'CNY', 'COP', 'COU', 'CRC', 'CSD', 'CSK', 'CUC', 'CUP', 'CVE', 'CYP', 'CZK',
    'DDM', 'DEM', 'DJF', 'DKK', 'DOP', 'DZD', 'ECS', 'ECV', 'EEK', 'EGP', 'ERN', 'ESA', 'ESB',
    'ESP', 'ETB', 'EUR', 'FIM', 'FJD', 'FKP', 'FRF', 'GBP', 'GEK', 'GEL', 'GHC', 'GHS', 'GIP',
    'GMD', 'GNF', 'GNS', 'GQE', 'GRD', 'GTQ', 'GWE', 'GWP', 'GYD', 'HKD', 'HNL', 'HRD', 'HRK',
    'HTG', 'HUF', 'IDR', 'IEP', 'ILP', 'ILR', 'ILS', 'INR', 'IQD', 'IRR', 'ISJ', 'ISK', 'ITL',
    'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRH', 'KRO', 'KRW', 'KWD', 'KYD',
    'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LTL', 'LTT', 'LUC', 'LUF', 'LUL', 'LVL', 'LVR',
    'LYD', 'MAD', 'MAF', 'MCF', 'MDC', 'MDL', 'MGA', 'MGF', 'MKD', 'MKN', 'MLF', 'MMK', 'MNT',
    'MOP', 'MRO', 'MRU', 'MTL', 'MTP', 'MUR', 'MVP', 'MVR', 'MWK', 'MXN', 'MXP', 'MXV', 'MYR',
    'MZE', 'MZM', 'MZN', 'NAD', 'NGN', 'NIC', 'NIO', 'NLG', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB',
    'PEI', 'PEN', 'PES', 'PGK', 'PHP', 'PKR', 'PLN', 'PLZ', 'PTE', 'PYG', 'QAR', 'RHD', 'ROL',
    'RON', 'RSD', 'RUB', 'RUR', 'RWF', 'SAR', 'SBD', 'SCR', 'SDD', 'SDG', 'SDP', 'SEK', 'SGD',
    'SHP', 'SIT', 'SKK', 'SLE', 'SLL', 'SOS', 'SRD', 'SRG', 'SSP', 'STD', 'STN', 'SUR', 'SVC',
    'SYP', 'SZL', 'THB', 'TJR', 'TJS', 'TMM', 'TMT', 'TND', 'TOP', 'TPE', 'TRL', 'TRY', 'TTD',
    'TWD', 'TZS', 'UAH', 'UAK', 'UGS', 'UGX', 'USD', 'USN', 'USS', 'UYI', 'UYP', 'UYU', 'UYW',
    'UZS', 'VEB', 'VED', 'VEF', 'VES', 'VND', 'VNN', 'VUV', 'WST', 'XAF', 'XAG', 'XAU', 'XBA',
    'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR', 'XEU', 'XFO', 'XFU', 'XOF', 'XPD', 'XPF', 'XPT',
    'XRE', 'XSU', 'XTS', 'XUA', 'XXX', 'YDD', 'YER', 'YUD', 'YUM', 'YUN', 'YUR', 'ZAL', 'ZAR',
    'ZMK', 'ZMW', 'ZRN', 'ZRZ', 'ZWD', 'ZWG', 'ZWL', 'ZWR'
 );
--> statement-breakpoint
UPDATE app_projects.task_time
   SET cost_currency = upper(btrim(cost_currency))
 WHERE cost_currency IS NOT NULL AND cost_currency <> upper(btrim(cost_currency));
--> statement-breakpoint
UPDATE app_projects.task_time
   SET cost_currency = NULL
 WHERE cost_currency IS NOT NULL AND cost_currency NOT IN (
    'ADP', 'AED', 'AFA', 'AFN', 'ALK', 'ALL', 'AMD', 'ANG', 'AOA', 'AOK', 'AON', 'AOR', 'ARA',
    'ARL', 'ARM', 'ARP', 'ARS', 'ATS', 'AUD', 'AWG', 'AZM', 'AZN', 'BAD', 'BAM', 'BAN', 'BBD',
    'BDT', 'BEC', 'BEF', 'BEL', 'BGL', 'BGM', 'BGN', 'BGO', 'BHD', 'BIF', 'BMD', 'BND', 'BOB',
    'BOL', 'BOP', 'BOV', 'BRB', 'BRC', 'BRE', 'BRL', 'BRN', 'BRR', 'BRZ', 'BSD', 'BTN', 'BUK',
    'BWP', 'BYB', 'BYN', 'BYR', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLE', 'CLF', 'CLP',
    'CNH', 'CNX', 'CNY', 'COP', 'COU', 'CRC', 'CSD', 'CSK', 'CUC', 'CUP', 'CVE', 'CYP', 'CZK',
    'DDM', 'DEM', 'DJF', 'DKK', 'DOP', 'DZD', 'ECS', 'ECV', 'EEK', 'EGP', 'ERN', 'ESA', 'ESB',
    'ESP', 'ETB', 'EUR', 'FIM', 'FJD', 'FKP', 'FRF', 'GBP', 'GEK', 'GEL', 'GHC', 'GHS', 'GIP',
    'GMD', 'GNF', 'GNS', 'GQE', 'GRD', 'GTQ', 'GWE', 'GWP', 'GYD', 'HKD', 'HNL', 'HRD', 'HRK',
    'HTG', 'HUF', 'IDR', 'IEP', 'ILP', 'ILR', 'ILS', 'INR', 'IQD', 'IRR', 'ISJ', 'ISK', 'ITL',
    'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRH', 'KRO', 'KRW', 'KWD', 'KYD',
    'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LTL', 'LTT', 'LUC', 'LUF', 'LUL', 'LVL', 'LVR',
    'LYD', 'MAD', 'MAF', 'MCF', 'MDC', 'MDL', 'MGA', 'MGF', 'MKD', 'MKN', 'MLF', 'MMK', 'MNT',
    'MOP', 'MRO', 'MRU', 'MTL', 'MTP', 'MUR', 'MVP', 'MVR', 'MWK', 'MXN', 'MXP', 'MXV', 'MYR',
    'MZE', 'MZM', 'MZN', 'NAD', 'NGN', 'NIC', 'NIO', 'NLG', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB',
    'PEI', 'PEN', 'PES', 'PGK', 'PHP', 'PKR', 'PLN', 'PLZ', 'PTE', 'PYG', 'QAR', 'RHD', 'ROL',
    'RON', 'RSD', 'RUB', 'RUR', 'RWF', 'SAR', 'SBD', 'SCR', 'SDD', 'SDG', 'SDP', 'SEK', 'SGD',
    'SHP', 'SIT', 'SKK', 'SLE', 'SLL', 'SOS', 'SRD', 'SRG', 'SSP', 'STD', 'STN', 'SUR', 'SVC',
    'SYP', 'SZL', 'THB', 'TJR', 'TJS', 'TMM', 'TMT', 'TND', 'TOP', 'TPE', 'TRL', 'TRY', 'TTD',
    'TWD', 'TZS', 'UAH', 'UAK', 'UGS', 'UGX', 'USD', 'USN', 'USS', 'UYI', 'UYP', 'UYU', 'UYW',
    'UZS', 'VEB', 'VED', 'VEF', 'VES', 'VND', 'VNN', 'VUV', 'WST', 'XAF', 'XAG', 'XAU', 'XBA',
    'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR', 'XEU', 'XFO', 'XFU', 'XOF', 'XPD', 'XPF', 'XPT',
    'XRE', 'XSU', 'XTS', 'XUA', 'XXX', 'YDD', 'YER', 'YUD', 'YUM', 'YUN', 'YUR', 'ZAL', 'ZAR',
    'ZMK', 'ZMW', 'ZRN', 'ZRZ', 'ZWD', 'ZWG', 'ZWL', 'ZWR'
 );
--> statement-breakpoint
-- Whether any costed time over an optional date range has no currency: a
-- frozen row with no cost_currency, or a row costed at a rate with none.
CREATE FUNCTION app_projects.project_time_cost_unlabelled(p_project uuid, p_from date, p_to date)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_exact_scope('projects:margin:read') THEN
    RAISE EXCEPTION 'time_cost_refused' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM app_projects.task_time tt
      LEFT JOIN LATERAL (
        SELECT c.rate_minor, c.currency
          FROM app_projects.cost_rates c
         WHERE c.org_id = v_org
           AND c.user_id = tt.user_id
           AND c.effective_from <= tt.work_date
         ORDER BY c.effective_from DESC
         LIMIT 1
      ) r ON true
     WHERE tt.org_id = v_org
       AND tt.project_id = p_project
       AND (p_from IS NULL OR tt.work_date >= p_from)
       AND (p_to IS NULL OR tt.work_date <= p_to)
       AND CASE WHEN tt.cost_minor IS NOT NULL THEN tt.cost_currency IS NULL
                ELSE r.rate_minor IS NOT NULL AND r.currency IS NULL END);
END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_time_cost_unlabelled(uuid, date, date) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.project_time_cost_unlabelled(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.project_time_cost_unlabelled(uuid, date, date) TO liaison_rls, liaison_app;
