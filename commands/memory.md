---
description: Gestisci la memoria a lungo termine (leggi, ricordi, aggiornamenti, cancellazioni, ispezione)
---

L'utente vuole gestire la propria memoria a lungo termine. Usa gli strumenti dedicati in base alla richiesta:

- Lettura/ricerca: usa `memory_read` con la query se presente; riporta un riepilogo conciso dei fatti rilevanti.
- Salvataggio (`remember <fatto>` o un fatto esplicito): usa `memory_write`; se l'utente menziona "questo progetto" o "questo repo", imposta `scope: "project"`.
- Correzione (`update <fatto>`): usa `memory_update` cercando prima con `memory_read` se non ha dato un id. Se una memoria è `conflicted`, proporre all'utente di risolverla con `memory_update`.
- Cancellazione (`forget <testo>`): usa `memory_forget` (con `id` se noto, altrimenti testo).
- Svuotamento (`clear`): usa `memory_clear`.
- Origine di una memoria (`why <id>`): usa `memory_why` e riporta provenance e motivazione del ranking.
- Ispezione (`stats`, `recent`, `conflicts`, `project`, `surfaced`): usa `memory_inspect` con la view corrispondente; in particolare `conflicts` per le memorie da risolvere e `surfaced` per spiegare perché una memoria è stata iniettata.
- Ripresa (`resume`): usa `memory_handoff` con `action: "show"` e riassumi dove era arrivata l'ultima sessione di questo progetto (richiesta, file toccati, prossimi passi); `list` per l'elenco, `dismiss` per non riproporla.
- Feedback su una memoria utilmente surfaceata (utile/irrilevante): usa `memory_useful` / `memory_irrelevant` con l'`id`.

Lingua: rispondi nella stessa lingua dell'utente.
