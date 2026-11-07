-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The newest inbound mail from one address, per org: what a follow-up reads to
-- learn whether the other side has answered.
--
-- First in its batch on purpose. The migrator runs every pending file in one
-- transaction, so each lock lasts to the commit, and this build is the long step:
-- anything locked before it would wait through it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- index-build: app_mail.messages 1000000 1304
CREATE INDEX messages_org_inbound_sender_idx
  ON app_mail.messages (org_id, lower(from_address->>'email'), sent_at DESC)
  WHERE direction = 'inbound';
