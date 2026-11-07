-- SPDX-License-Identifier: FSL-1.1-ALv2
-- "Not now" on an attention item: it stays out of the feed until this moment.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.attention_events ADD COLUMN set_aside_until timestamptz;
