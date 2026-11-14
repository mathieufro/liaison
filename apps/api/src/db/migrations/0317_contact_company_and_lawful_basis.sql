-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A contact's company, and what is recorded about the lawful basis for
-- writing to them.
--
-- Nothing is claimed about an existing contact. Every new column is NULL on
-- every existing row, with no default: no lawful basis, consumer status or
-- data source is recorded until a person, an import column or a create path
-- that knows it writes one. Readers treat NULL as unknown (an unknown consumer
-- status as a consumer, an unknown source as a third party). contacts.company
-- (the free text) stays as it is.
--
-- Every kernel.contacts statement of the batch is here, at its end: the
-- migrator applies every pending file in one transaction, so the lock taken on
-- contacts is held from its first statement to the commit.
--
-- Lock time, measured as the migrator runs it: this batch (now 0284 to 0294)
-- in one transaction, on a database at 0282 holding
-- 1 000 000 contacts, 100 000 users and 1 000 000 approval requests (synthetic,
-- until the largest deployment's row counts are read). The batch takes 465 ms (the slower of two runs).
-- Time each table is blocked for writers, from the first statement that locks
-- it to the commit:
--   kernel.contacts           170 ms (the statements below: 111 ms add, 54 ms index)
--   kernel.users              446 ms (from 0288 on)
--   kernel.approval_requests  429 ms (from 0288 on)
--   sum                      1045 ms, under the 10 s maintenance bar.
-- The measurement predates 0283 (a scope re-seed that also bumps users'
-- permission_version), which a database at 0282 now runs first; it was not
-- re-measured with it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: nullable columns with no default; the previous release never writes them, and every existing row is NULL, which every CHECK and the foreign key accept
ALTER TABLE kernel.contacts
  ADD COLUMN lawful_basis text
    CHECK (lawful_basis IN ('consent', 'customer', 'professional_interest', 'generic_address')),
  ADD COLUMN lawful_basis_source text,
  ADD COLUMN lawful_basis_at timestamptz,
  ADD COLUMN is_consumer boolean,
  -- ISO 3166-1 alpha-2
  ADD COLUMN recipient_country text,
  ADD COLUMN data_source text CHECK (data_source IN ('direct', 'third_party', 'enrichment')),
  ADD COLUMN art14_notice_at timestamptz,
  ADD COLUMN company_id uuid REFERENCES kernel.companies(id) ON DELETE SET NULL;
--> statement-breakpoint
-- index-build: kernel.contacts 1000000 54
CREATE INDEX contacts_company_idx ON kernel.contacts (org_id, company_id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
-- The scopes 0291 and 0292 seeded reach sessions on their next refresh.
-- Run as liaison_admin (BYPASSRLS): the grant tables force row security, so a
-- migration login that is no superuser would read no row and seed nothing.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
UPDATE kernel.users u
   SET permission_version = u.permission_version + 1
 WHERE u.id IN (
   SELECT ur.user_id FROM kernel.user_roles ur
     JOIN kernel.role_scope_grants g ON g.role_id = ur.role_id
    WHERE g.scope IN ('kernel:companies:read', 'kernel:companies:write', 'kernel:companies:*',
                      'mail:suppressions:read', 'mail:suppressions:write', 'mail:suppressions:*')
   UNION
   SELECT g.user_id FROM kernel.user_scope_grants g
    WHERE g.scope IN ('kernel:companies:read', 'kernel:companies:write', 'kernel:companies:*',
                      'mail:suppressions:read', 'mail:suppressions:write', 'mail:suppressions:*')
 );
--> statement-breakpoint
RESET ROLE;
