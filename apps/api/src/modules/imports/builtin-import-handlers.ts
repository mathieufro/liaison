// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host handlers of the import kinds built-in apps (`apps/api/src/apps/*`)
 * declare and of the kernel kinds (kernel-kinds.ts), keyed by full kind name
 * (A25). A kind of an installed app has no
 * entry here and runs its bundle export instead. Loaded lazily by the runner.
 */
import { calendarEventImportHandler } from "~/apps/calendar/import-kind"
import { companyImportHandler, contactImportHandler } from "~/apps/contacts/import-kind"
import { collectionImportHandler, documentImportHandler } from "~/apps/knowledge/import-kind"
import { dealImportHandler } from "~/apps/projects/import-deal-kind"
import {
  projectImportHandler,
  taskImportHandler,
  templateImportHandler,
} from "~/apps/projects/import-kind"
import {
  categoryImportHandler,
  replyTemplateImportHandler,
  ticketImportHandler,
} from "~/apps/tickets/import-kind"
import { routineImportHandler, skillImportHandler } from "~/modules/imports/kernel-kinds/agents"
import { messageImportHandler, threadImportHandler } from "~/modules/imports/kernel-kinds/chat"
import type { HostImportHandler } from "~/modules/imports/types"

export const BUILTIN_IMPORT_HANDLERS: Record<string, HostImportHandler> = {
  "agents.routine": routineImportHandler,
  "agents.skill": skillImportHandler,
  "chat.message": messageImportHandler,
  "chat.thread": threadImportHandler,
  "calendar.event": calendarEventImportHandler,
  "contacts.company": companyImportHandler,
  "contacts.contact": contactImportHandler,
  "knowledge.collection": collectionImportHandler,
  "knowledge.document": documentImportHandler,
  "projects.deal": dealImportHandler,
  "projects.project": projectImportHandler,
  "projects.task": taskImportHandler,
  "projects.template": templateImportHandler,
  "tickets.ticket": ticketImportHandler,
  "tickets.category": categoryImportHandler,
  "tickets.reply-template": replyTemplateImportHandler,
}
