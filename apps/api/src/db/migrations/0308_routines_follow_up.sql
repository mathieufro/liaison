-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A routine that is a follow-up. No index: it is read with the row.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.routines ADD COLUMN follow_up boolean NOT NULL DEFAULT false;
