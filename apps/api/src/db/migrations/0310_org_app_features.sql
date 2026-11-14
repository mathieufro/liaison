-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A switch inside an app, per org. A member reads their own org's rows and has
-- no write path: writes go through one kernel module on a privileged client,
-- after the feature's declared admin scope is checked.
--
-- The foreign key to kernel.users takes a share lock on it: writes to users wait
-- until the batch commits, reads do not.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE kernel.org_app_features (
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  app_name text NOT NULL,
  feature text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  changed_by uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  changed_at timestamptz,
  PRIMARY KEY (org_id, app_name, feature)
);
--> statement-breakpoint
ALTER TABLE kernel.org_app_features ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.org_app_features FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_app_features_select ON kernel.org_app_features
  FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid);
--> statement-breakpoint
-- Named one by one: default privileges follow whoever runs the migration, and
-- they would give liaison_rls write rights this table must never answer to.
REVOKE ALL ON kernel.org_app_features FROM liaison_rls;
--> statement-breakpoint
GRANT SELECT ON kernel.org_app_features TO liaison_rls;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.org_app_features TO liaison_admin, liaison_app;
