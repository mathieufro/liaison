// SPDX-License-Identifier: FSL-1.1-ALv2
//
// French for this app's UI, keyed by the English source text (see i18n.ts).
// Formal "vous", no dash punctuation (the repo's lint:copy rule).
export const FR: Record<string, string> = {
  "1 day late": "1 jour de retard",
  "1 day left": "1 jour restant",
  "{{n}} days late": "{{n}} jours de retard",
  "{{n}} days left": "{{n}} jours restants",
  today: "aujourd'hui",
  "in 1 day": "dans 1 jour",
  "in {{n}} days": "dans {{n}} jours",
  Held: "En attente",
  "Waits for the key": "Attend la clé",
  Approve: "Approuver",
  Deny: "Refuser",
  Review: "Examiner",
  "Showing what was read as of {{time}}. Nothing updates until the key works.":
    "Ce qui s'affiche date de {{time}}. Rien ne se met à jour tant que la clé ne fonctionne pas.",
  "Showing what was read before the key stopped working. Nothing updates until it works.":
    "Ce qui s'affiche date d'avant l'arrêt de la clé. Rien ne se met à jour tant qu'elle ne fonctionne pas.",
  "Stripe is not connected": "Stripe n'est pas connecté",
  "Nothing has been read from Stripe and nothing has been changed.":
    "Rien n'a été lu dans Stripe et rien n'a été modifié.",
  "An admin connects Stripe in Settings, Apps, Stripe, with a restricted key that starts with rk_.":
    "Un administrateur connecte Stripe dans Paramètres, Apps, Stripe, avec une clé restreinte qui commence par rk_.",
  "Connect Stripe": "Connecter Stripe",
  "Key stored, waiting for Stripe's first update":
    "Clé enregistrée, en attente de la première mise à jour de Stripe",
  "The key works. The import starts when Stripe sends its first update to this workspace.":
    "La clé fonctionne. L'import démarre dès que Stripe envoie sa première mise à jour à cet espace.",
  "In Stripe, open Developers, Webhooks, and add the Liaison endpoint.":
    "Dans Stripe, ouvrez Développeurs, Webhooks, et ajoutez le point de terminaison de Liaison.",
  "Give the signing secret to the agent in its form.":
    "Donnez le secret de signature à l'agent dans son formulaire.",
  "Open webhooks in Stripe": "Ouvrir les webhooks dans Stripe",
  "Check again": "Vérifier à nouveau",
  "First import is running": "Le premier import est en cours",
  "You have nothing to do, and you can close this page. Figures show once everything is read.":
    "Vous n'avez rien à faire et pouvez fermer cette page. Les chiffres s'affichent une fois tout lu.",
  "No routine runs on this data, and nothing goes to a customer until the import ends.":
    "Aucune routine n'utilise ces données et rien n'est envoyé à un client avant la fin de l'import.",
  "Connected, and this account has no subscriptions": "Connecté, et ce compte n'a aucun abonnement",
  "The key works and Stripe answers. It found no customers and no subscriptions.":
    "La clé fonctionne et Stripe répond. Il n'a trouvé ni client ni abonnement.",
  "Expected customers? This is a test key, and it only sees test data. Use a live key, rk_live_.":
    "Vous attendiez des clients ? C'est une clé de test, qui ne voit que les données de test. Utilisez une clé live, rk_live_.",
  "Just starting? Nothing to do. The first subscription appears here within a minute of its creation.":
    "Vous débutez ? Rien à faire. Le premier abonnement apparaît ici moins d'une minute après sa création.",
  "Use another key": "Utiliser une autre clé",
  "Open Stripe": "Ouvrir Stripe",
  "Stripe no longer accepts the key": "Stripe n'accepte plus la clé",
  "Someone revoked or rolled it in Stripe. Nothing has been lost.":
    "Quelqu'un l'a révoquée ou renouvelée dans Stripe. Rien n'a été perdu.",
  "In Stripe, create a new restricted key with the same permissions.":
    "Dans Stripe, créez une nouvelle clé restreinte avec les mêmes permissions.",
  "Give it to the agent in its form. It checks the permissions again and catches up.":
    "Donnez-la à l'agent dans son formulaire. Il revérifie les permissions et rattrape son retard.",
  "Until then refunds cannot run. Approvals waiting stay open, and you decide them once the key works.":
    "D'ici là, les remboursements ne peuvent pas partir. Les approbations en attente restent ouvertes, et vous les décidez une fois la clé rétablie.",
  "Replace the key": "Remplacer la clé",
  "Open API keys in Stripe": "Ouvrir les clés API dans Stripe",
  "This key belongs to another Stripe account": "Cette clé appartient à un autre compte Stripe",
  "Nothing was written, so the data already read is untouched.":
    "Rien n'a été écrit, les données déjà lues sont intactes.",
  "Check which account and which mode the key belongs to, then replace it or run the check again.":
    "Vérifiez le compte et le mode de la clé, puis remplacez-la ou relancez la vérification.",
  "Until then refunds cannot run. Approvals waiting stay open.":
    "D'ici là, les remboursements ne peuvent pas partir. Les approbations en attente restent ouvertes.",
  "No update from Stripe since {{time}}": "Aucune mise à jour de Stripe depuis {{time}}",
  "No update from Stripe for a while": "Aucune mise à jour de Stripe depuis un moment",
  "That was over {{hours}} hours ago. Liaison usually gets an update every few minutes.":
    "C'était il y a plus de {{hours}} heures. Liaison reçoit d'habitude une mise à jour toutes les quelques minutes.",
  "Liaison usually gets an update every few minutes.":
    "Liaison reçoit d'habitude une mise à jour toutes les quelques minutes.",
  "In Stripe, open Developers, Webhooks, then the Liaison endpoint. If it is disabled, enable it.":
    "Dans Stripe, ouvrez Développeurs, Webhooks, puis le point de terminaison de Liaison. S'il est désactivé, activez-le.",
  "If it shows failures, the signing secret may have changed. Give the agent the new one.":
    "S'il affiche des échecs, le secret de signature a peut-être changé. Donnez le nouveau à l'agent.",
  "Stripe resends missed updates for up to 72 hours, so fix this before then and nothing is lost.":
    "Stripe renvoie les mises à jour manquées pendant 72 heures : corrigez avant et rien n'est perdu.",
  "Until then Liaison checks Stripe itself every 15 minutes.":
    "D'ici là, Liaison interroge Stripe lui-même toutes les 15 minutes.",
  "The key cannot read {{what}}, the rest is fine":
    "La clé ne peut pas lire {{what}}, le reste fonctionne",
  "everything it needs": "tout ce dont elle a besoin",
  "Figures that do not need it still come through.":
    "Les chiffres qui n'en dépendent pas arrivent normalement.",
  "In Stripe, add Read on the missing resource to the same key. You do not need a new key.":
    "Dans Stripe, ajoutez la lecture de la ressource manquante à la même clé. Vous n'avez pas besoin d'une nouvelle clé.",
  "Then check again. The agent fills in what is missing.":
    "Puis vérifiez à nouveau. L'agent complète ce qui manque.",
  "Open the key in Stripe": "Ouvrir la clé dans Stripe",
  "MRR shows once all {{n}} subscriptions are read.":
    "Le MRR s'affiche une fois les {{n}} abonnements lus.",
  "MRR shows once every subscription is read.":
    "Le MRR s'affiche une fois tous les abonnements lus.",
  "new": "nouveaux",
  upgrade: "montée en gamme",
  downgrade: "baisse de gamme",
  cancelled: "résiliés",
  up: "en hausse de",
  down: "en baisse de",
  unchanged: "inchangé",
  "Each currency is its own line and is never converted.":
    "Chaque devise a sa propre ligne et n'est jamais convertie.",
  "Movements incomplete before {{date}}.": "Mouvements incomplets avant le {{date}}.",
  "The key was checked.": "La clé a été vérifiée.",
  "The check did not run. Nothing changed.": "La vérification n'a pas eu lieu. Rien n'a changé.",
  "{{done}} of {{total}}": "{{done}} sur {{total}}",
  next: "ensuite",
  Customers: "Clients",
  Subscriptions: "Abonnements",
  Invoices: "Factures",
  Payments: "Paiements",
  Refunds: "Remboursements",
  Disputes: "Litiges",
  Other: "Autre",
  Home: "Accueil",
  Stripe: "Stripe",
  "Stripe dashboard": "Tableau de bord Stripe",
  "Nothing was decided. It is still waiting.": "Rien n'a été décidé. La demande attend toujours.",
  "Needs attention ({{n}})": "À traiter ({{n}})",
  "No failed payments, disputes, refund requests or trials ending. Your agents will bring the next one here.":
    "Aucun paiement échoué, litige, demande de remboursement ni essai qui se termine. Vos agents amèneront le prochain ici.",
  "Failed payments": "Paiements échoués",
  "{{n}} to look at": "{{n}} à regarder",
  "{{amount}} per month": "{{amount}} par mois",
  "Card ending {{last4}}.": "Carte se terminant par {{last4}}.",
  "No card on file.": "Aucune carte enregistrée.",
  "{{amount}} is unpaid.": "{{amount}} impayés.",
  "Stripe is trying 1 more card again by itself. Nothing to do yet.":
    "Stripe réessaie 1 autre carte tout seul. Rien à faire pour l'instant.",
  "Stripe is trying {{n}} more cards again by itself. Nothing to do yet.":
    "Stripe réessaie {{n}} autres cartes tout seul. Rien à faire pour l'instant.",
  "{{amount}} of MRR": "{{amount}} de MRR",
  "Requests waiting for you": "Demandes qui vous attendent",
  "Waiting for your approval": "En attente de votre approbation",
  "Disputed {{amount}}": "{{amount}} contestés",
  "Evidence is due in Stripe by {{date}}.":
    "Les preuves sont à remettre dans Stripe avant le {{date}}.",
  "Evidence is due in Stripe.": "Les preuves sont à remettre dans Stripe.",
  "Open in Stripe": "Ouvrir dans Stripe",
  "Trials ending": "Essais qui se terminent",
  "{{n}} within 7 days": "{{n}} sous 7 jours",
  "Ends {{date}}.": "Se termine le {{date}}.",
  "Card on file, it starts on its own.": "Carte enregistrée, il démarre tout seul.",
  "No card on file. It stops unless someone adds one.":
    "Aucune carte enregistrée. Il s'arrête sauf si quelqu'un en ajoute une.",
  "Monthly recurring revenue": "Revenu mensuel récurrent",
  "{{change}} since {{date}}, from {{start}}": "{{change}} depuis le {{date}}, contre {{start}}",
  "{{n}} paying": "{{n}} payants",
  "{{amount}} of it is past due.": "{{amount}} sont en retard de paiement.",
  "As of {{time}}. Not updating.": "À {{time}}. Ne se met pas à jour.",
  "How MRR is computed": "Comment le MRR est calculé",
  "Loading Stripe": "Chargement de Stripe",
  "Live account.": "Compte live.",
  "Test mode.": "Mode test.",
  "Last update from Stripe at {{time}}.": "Dernière mise à jour de Stripe à {{time}}.",
  "Not connected.": "Non connecté.",
  "Linked by you. Nothing changed in Stripe.": "Lié par vous. Rien n'a changé dans Stripe.",
  "Nothing was linked. Try again, or ask the agent.":
    "Rien n'a été lié. Réessayez, ou demandez à l'agent.",
  "Not yet linked to a company in Contacts": "Pas encore lié à une société dans Contacts",
  Link: "Lier",
  "Another company": "Une autre société",
  "Create company": "Créer la société",
  "Ask the agent": "Demander à l'agent",
  "Search by name, email or Stripe ID, or ask the agent":
    "Rechercher par nom, e-mail ou identifiant Stripe, ou demander à l'agent",
  "The customers could not be read just now. What was loaded stays below.":
    "Les clients n'ont pas pu être lus à l'instant. Ce qui était chargé reste ci-dessous.",
  "Sorted: problems first, then by name": "Tri : problèmes d'abord, puis par nom",
  "Reading the mirror": "Lecture du miroir",
  "No customer matches.": "Aucun client ne correspond.",
  Linked: "Lié",
  "Not linked": "Non lié",
  "Showing {{n}}. Search narrows it, or ask the agent for a list.":
    "{{n}} affichés. La recherche affine la liste, ou demandez une liste à l'agent.",
  "Customers billed outside Stripe are not here. Cards show brand, last 4 and expiry only.":
    "Les clients facturés hors de Stripe ne sont pas ici. Les cartes n'affichent que la marque, les 4 derniers chiffres et l'expiration.",
  "This asks for a new refund of {{amount}} to the {{card}}. It still waits for a person's approval, and nothing moves until then.":
    "Ceci demande un nouveau remboursement de {{amount}} sur la carte {{card}}. Il attend encore l'approbation d'une personne, et rien ne bouge d'ici là.",
  "This asks the agent to issue a credit note of {{amount}} for the refund already made in Stripe. It is a new approval, and nothing is issued until a person approves it.":
    "Ceci demande à l'agent d'émettre un avoir de {{amount}} pour le remboursement déjà fait dans Stripe. C'est une nouvelle approbation, et rien n'est émis tant qu'une personne ne l'a pas approuvée.",
  "Already refunded in Stripe": "Déjà remboursé dans Stripe",
  "Liaison checks Stripe just before refunding, so nothing goes out twice. The refund made has no credit note yet, and it needs one.":
    "Liaison interroge Stripe juste avant de rembourser, donc rien ne part deux fois. Le remboursement fait n'a pas encore d'avoir, et il lui en faut un.",
  "Issue the credit note for it": "Émettre l'avoir correspondant",
  Dismiss: "Ignorer",
  "Stripe refused the refund": "Stripe a refusé le remboursement",
  "No credit note was issued, so Stripe and your books still agree. Nothing is lost.":
    "Aucun avoir n'a été émis, donc Stripe et votre comptabilité concordent toujours. Rien n'est perdu.",
  "Try again": "Réessayer",
  "Refund {{amount}}": "Rembourser {{amount}}",
  "Will not run if this charge is already refunded in Stripe. Checked again at the moment it runs.":
    "Ne s'exécutera pas si ce paiement est déjà remboursé dans Stripe. Vérifié de nouveau au moment de l'exécution.",
  "Save and approve": "Enregistrer et approuver",
  Cancel: "Annuler",
  Edit: "Modifier",
  Reject: "Refuser",
  "A new refund is waiting for a person's approval.":
    "Un nouveau remboursement attend l'approbation d'une personne.",
  "Please issue the credit note for the refund of {{charge}} already made in Stripe, for my approval.":
    "Merci d'émettre l'avoir pour le remboursement de {{charge}} déjà fait dans Stripe, pour mon approbation.",
  "Asked in the discussion. The credit note waits for approval.":
    "Demandé dans la discussion. L'avoir attend une approbation.",
  "Nothing was sent. Try again in a moment.": "Rien n'a été envoyé. Réessayez dans un instant.",
  "Stripe: refund": "Stripe : remboursement",
  Payment: "Paiement",
  To: "Vers",
  Refundable: "Remboursable",
  "Amount to refund, VAT included": "Montant à rembourser, TVA comprise",
  "Type an amount such as {{example}}.": "Saisissez un montant comme {{example}}.",
  "The amount must be more than zero.": "Le montant doit être supérieur à zéro.",
  "At most {{left}} is still refundable.": "Au plus {{left}} reste remboursable.",
  Confirm: "Confirmer",
  "No Stripe customer is linked to this contact.": "Aucun client Stripe n'est lié à ce contact.",
  "No Stripe customer is linked to this company.": "Aucun client Stripe n'est lié à cette société.",
  "No Stripe customer is linked to this ticket's contact.":
    "Aucun client Stripe n'est lié au contact de ce ticket.",
  "Past due since {{date}}": "En retard depuis le {{date}}",
  "Past due": "En retard de paiement",
  "No subscription": "Aucun abonnement",
  "Last update from Stripe {{date}}": "Dernière mise à jour de Stripe le {{date}}",
  All: "Tous",
  Trial: "Essai",
  Cancelled: "Résilié",
  "Deleted in Stripe": "Supprimé dans Stripe",
  "Trial, ends {{date}}": "Essai, se termine le {{date}}",
  Paused: "En pause",
  "Ends {{date}}": "Se termine le {{date}}",
  Active: "Actif",
  "Stripe retries on {{date}}": "Stripe réessaie le {{date}}",
  "No retry left. A person decides.": "Plus de nouvel essai. Une personne décide.",
  "Trial ends {{date}}, then it is charged": "L'essai se termine le {{date}}, puis il est facturé",
  "Renews {{date}}": "Se renouvelle le {{date}}",
  "No card": "Aucune carte",
  Card: "Carte",
  "Personal email, and no company by that name. The agent could not suggest one.":
    "E-mail personnel, et aucune société de ce nom. L'agent n'a pas pu en suggérer une.",
  "No company has this email domain.": "Aucune société n'a ce domaine d'e-mail.",
  "Suggested: same email domain": "Suggestion : même domaine d'e-mail",
  Paid: "Payé",
  Unpaid: "Impayé",
  Draft: "Brouillon",
  Void: "Annulée",
  Uncollectible: "Irrécouvrable",
  "Issued by Liaison, collected by Stripe": "Émise par Liaison, encaissée par Stripe",
  "Issued by Stripe": "Émise par Stripe",
  Failed: "Échoué",
  Pending: "En attente",
  Disputed: "Contesté",
  "evidence due {{date}}": "preuves à fournir le {{date}}",
  "Please prepare a refund of {{what}} for {{who}} ({{customer}}), for my approval.":
    "Merci de préparer un remboursement de {{what}} pour {{who}} ({{customer}}), pour mon approbation.",
  "Please prepare a refund for {{who}} ({{customer}}), for my approval.":
    "Merci de préparer un remboursement pour {{who}} ({{customer}}), pour mon approbation.",
  "Please prepare the cancellation of {{what}} for {{who}} ({{customer}}), for my approval.":
    "Merci de préparer la résiliation de {{what}} pour {{who}} ({{customer}}), pour mon approbation.",
  "Please prepare a cancellation for {{who}} ({{customer}}), for my approval.":
    "Merci de préparer une résiliation pour {{who}} ({{customer}}), pour mon approbation.",
  "Link a customer": "Lier un client",
  Amount: "Montant",
  Status: "Statut",
  Expired: "Expirée",
  "Open customer": "Ouvrir le client",
  "Asked in the discussion. The agent prepares the refund for your approval.":
    "Demandé dans la discussion. L'agent prépare le remboursement pour votre approbation.",
  "Asked in the discussion. The agent prepares the cancellation for your approval.":
    "Demandé dans la discussion. L'agent prépare la résiliation pour votre approbation.",
  "This customer is not in the Stripe mirror.": "Ce client n'est pas dans le miroir Stripe.",
  Refund: "Rembourser",
  "Cancel subscription": "Résilier l'abonnement",
  "The agent prepares a refund or cancellation for your approval.":
    "L'agent prépare un remboursement ou une résiliation pour votre approbation.",
  Company: "Société",
  "People, deals and tickets are on the company page":
    "Les personnes, affaires et tickets sont sur la page de la société",
  "A contact has this email: {{email}}. It is not verified, so a person confirms it.":
    "Un contact a cet e-mail : {{email}}. Il n'est pas vérifié, donc une personne le confirme.",
  "Link this contact": "Lier ce contact",
  "Linked to a contact": "Lié à un contact",
  "Open the company": "Ouvrir la société",
  "Linked by a person.": "Lié par une personne.",
  "Linked by matching.": "Lié par correspondance.",
  "Unlinked. Nothing changed in Stripe.": "Délié. Rien n'a changé dans Stripe.",
  Unlink: "Délier",
  "No subscription.": "Aucun abonnement.",
  "Payment method": "Moyen de paiement",
  "Liaison keeps only the brand, last 4 and expiry":
    "Liaison ne garde que la marque, les 4 derniers chiffres et l'expiration",
  "A new card goes on a page hosted by Stripe. No screen or agent here takes a card number.":
    "Une nouvelle carte se saisit sur une page hébergée par Stripe. Aucun écran ni agent ici ne prend de numéro de carte.",
  "No invoices.": "Aucune facture.",
  "Newest first": "Les plus récents d'abord",
  "No payments.": "Aucun paiement.",
  "Refunded {{amount}}": "{{amount}} remboursés",
  "Refunds waiting": "Remboursements en attente",
  "No disputes, ever.": "Aucun litige, jamais.",
  "Answer it in Stripe": "À traiter dans Stripe",
  Discussion: "Discussion",
  "No customer has been read from Stripe yet. They show here once Stripe is connected.":
    "Aucun client n'a encore été lu dans Stripe. Ils s'afficheront ici une fois Stripe connecté.",
  "Not connected": "Non connecté",
  Connected: "Connecté",
  "Setting up": "Mise en place",
  "Needs a look": "À vérifier",
}
