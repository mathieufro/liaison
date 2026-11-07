-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Who an approval is for, and who is away.
--
-- Nothing changes for an existing row: no route is set, nobody is away.
--
-- kernel.away_ranges holds dates and never a reason: `source_event_ref` is the
-- calendar event's id, not its title. Others in the org read an active range;
-- an `asked` or `declined` one is its person's alone. A member has no direct
-- write path, not on their own row either: writes go through one kernel module.
--
-- approval_requests_route_person_idx serves the ON DELETE SET NULL of route_person_id:
-- without it, removing a user scans every approval request.
--
-- The foreign keys take a share lock on kernel.users: writes to users wait until
-- the batch commits, reads do not.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- expand-safe: nullable columns, no default, no policy touched; the previous release never writes them
ALTER TABLE kernel.approval_requests
  ADD COLUMN route_person_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  ADD COLUMN route_company_id uuid;
--> statement-breakpoint
-- index-build: kernel.approval_requests 1000000 949
CREATE INDEX approval_requests_route_person_idx ON kernel.approval_requests (route_person_id)
  WHERE route_person_id IS NOT NULL;
--> statement-breakpoint
-- expand-safe: a nullable column, no default; the previous release never writes it
ALTER TABLE kernel.user_preferences
  ADD COLUMN next_in_line_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE kernel.away_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date,
  weekdays smallint[],
  next_in_line_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('said', 'lead', 'calendar')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'asked', 'declined')),
  source_event_ref text,
  ended_early_on date,
  set_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK (ends_on IS NOT NULL OR weekdays IS NOT NULL),
  CHECK ((source = 'calendar') = (source_event_ref IS NOT NULL)),
  CHECK (status = 'active' OR source = 'calendar')
);
--> statement-breakpoint
CREATE UNIQUE INDEX away_ranges_event_idx ON kernel.away_ranges (org_id, user_id, source_event_ref)
  WHERE source_event_ref IS NOT NULL;
--> statement-breakpoint
CREATE INDEX away_ranges_person_idx ON kernel.away_ranges (org_id, user_id, starts_on);
--> statement-breakpoint
ALTER TABLE kernel.away_ranges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.away_ranges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY away_ranges_select ON kernel.away_ranges
  FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (status = 'active' OR user_id = (SELECT rls_ctx.user_id())::uuid)
  );
--> statement-breakpoint
-- Named one by one, as in kernel.org_app_features.
REVOKE ALL ON kernel.away_ranges FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT ON kernel.away_ranges TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.away_ranges TO liaison_admin, liaison_app;
--> statement-breakpoint
-- reviewed-dynamic: one nullable column on a table the calendar app's registration owns, added only where it exists. Registration declares the same column for a new instance.
DO $$
BEGIN
  IF to_regclass('app_calendar.events') IS NOT NULL THEN
    ALTER TABLE app_calendar.events ADD COLUMN IF NOT EXISTS event_type text;
  END IF;
END $$;
