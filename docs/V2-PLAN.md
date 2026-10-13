# rem-memory 2.0 — piano tecnico

Stato: bozza · 2026-10-13 · base: `opencode-memory` 1.7.2 (`22e5744`)

## Obiettivo

La 2.0 trasforma `@cioffi_ai/opencode-memory` in **`rem-memory`**: stesso ciclo
WRITE → DREAM → SURFACE, solo OpenCode V2, e due funzioni pensate per il coding
che nessun altro plugin di memoria offre insieme:

1. **Memorie ancorate al codice** — un fatto di progetto può riferirsi a un file
   (e a un simbolo); quando il codice cambia o sparisce, la memoria lo sa.
2. **Handoff di sessione** — a fine sessione resta una nota "dove eravamo"
   (richiesta, file toccati, TODO, prossimi passi) che la sessione successiva
   nello stesso progetto riceve una volta.

Tutta la logica nuova vive in moduli **indipendenti dall'host**: il futuro
adapter MCP / Claude Code (2.1+) sarà solo un altro host.

### Fuori scope 2.0

SQLite, server MCP e altri agenti, lezioni dagli errori, inbox di revisione,
grafo di entità, sync. Lo store resta JSON (versione 3, migrazione additiva).

---

## Sequenza delle PR

| PR | Titolo | Dim. | Dipende da | Versione |
|----|--------|------|-----------|----------|
| 0 | Spike API OpenCode V2 (non si mergia) | S | — | — |
| 1 | Rimozione V1 + rename `rem-memory` | M | — | 2.0.0-alpha.0 |
| 2 | Estrazione engine + schema store v3 | M | 1 | 2.0.0-alpha.1 |
| 3 | ① Ancore al codice e staleness | L | 0, 2 | 2.0.0-alpha.2 |
| 4 | ③ Handoff di sessione | L | 0, 2 | 2.0.0-beta.0 |
| 5 | Comando `/memory` nativo, docs, release | S | 3, 4 | 2.0.0 |

PR 3 e PR 4 sono parallelizzabili dopo la PR 2: toccano moduli diversi
(`src/engine/anchors.ts`, `src/engine/handoff.ts`); lo schema condiviso è già
fissato nella PR 2.

---

## PR 0 — Spike sulle API di OpenCode V2

Script usa-e-getta contro un binario OpenCode ≥ 2.0.18 reale (riusa il
modello deterministico di `scripts/verify-runtime.ts`). Risposte da scrivere in
`docs/spike-v2.md`; decidono i dettagli di PR 3/4.

1. **File toccati da una sessione.** In Code Mode le modifiche ai file
   compaiono in `session.context()` come part `tool` con `name` = `edit` /
   `write` / `apply_patch` e `input.filePath`, oppure solo come `execute` con
   codice? Quali nomi esatti?
2. **`vcs.status` / `vcs.get`**: cosa restituiscono in un repo git e fuori da
   git? Latenza?
3. **Todo**: esiste un tool `todowrite` (o equivalente) il cui input è
   leggibile da `tool.hook("execute.after")` o dalle part?
4. **Prima richiesta di una sessione**: il context hook permette di sapere se è
   la prima richiesta (conteggio messaggi `user` in `session.context`)?
5. **`command.transform`**: un plugin può registrare `/memory` con un prompt
   (per eliminare la copia manuale di `commands/memory.md`)?
6. **`session.hook("compaction")`**: payload disponibile? (utile in futuro per
   aggiornare l'handoff prima di una compaction.)

Fatto quando: ogni domanda ha risposta con un esempio di payload reale.

---

## PR 1 — Rimozione V1 e rename

**Rimuovere**
- `src/v1.ts`, `src/rerank.ts` (usato solo da V1; V2 ha il proprio rerank).
- `tests/v1-flags.test.ts`, `tests/containment.test.ts`,
  `tests/reranker.test.ts`, `tests/fixtures/v1-flags-check.ts`.
- `server` dall'export di `src/index.ts`; `server.js` e l'export `./server`
  (verificare nello spike che V2 non lo richieda più: in 1.7.0 serviva per il
  caricamento da directory — se serve ancora, tenerlo puntato a `setup`).
- In `src/config.ts`: `CONSOLIDATION_TITLE`, `RERANK_TITLE`,
  `SESSION_TOOLS_DENY_ALL`. L'opzione `gcChildAgeMs` resta **accettata ma
  ignorata** con un warning di deprecazione (altrimenti le config esistenti
  falliscono, perché le opzioni sconosciute sono un errore).
- Dipendenza `@opencode-ai/plugin`.

**Aggiornare a solo-V2**: `tests/config-instances.test.ts`,
`tests/tool-regressions.test.ts`, `scripts/verify-package.ts`,
`scripts/verify-runtime.ts` (togliere i rami `server()` e `OPENCODE_TEST_BIN_V1`).

**Rename**
- `package.json`: `name: "rem-memory"`, description, keywords, repository/
  homepage (rinominare il repo GitHub: i redirect restano attivi).
- Id plugin `cioffi.rem-memory`; prefisso log `[rem-memory]`;
  `SUMMARY.md` titolo `# rem-memory summary`.
- Variabili d'ambiente: `REM_MEMORY_*` primarie; `OPENCODE_MEMORY_*` lette come
  fallback con **un solo** warning di deprecazione per processo. Se entrambe
  sono presenti vince `REM_MEMORY_*`.
- Directory di default `~/.local/share/rem-memory`. **Migrazione**: se `dir`
  non è impostata esplicitamente, la nuova directory non ha `store.json` e la
  vecchia (`~/.local/share/opencode/memory`) sì → copia `store.json`,
  `state.json`, `SUMMARY.md` sotto lock e scrive `MIGRATED_TO_REM_MEMORY` nella
  vecchia. Mai cancellare la vecchia directory.
- Nomi dei tool `memory_*` invariati (già neutri rispetto all'host).

**Pacchetto vecchio**: ultima `@cioffi_ai/opencode-memory@1.7.3` con README che
rimanda a `rem-memory`, poi `npm deprecate`. Niente wrapper 2.x: chi passa
alla 2.0 deve comunque toccare la config (V1 rimosso), quindi un alias non
risparmia nulla e raddoppia la manutenzione.

Fatto quando: `bun run check` e `bun run verify:package` verdi; test nuovi per
fallback env, precedenza env, migrazione directory (incluso "dir esplicita →
nessuna migrazione" e "nuova directory già popolata → nessuna migrazione").

---

## PR 2 — Estrazione engine (nessun cambiamento di comportamento)

`src/v2.ts` (929 righe) mescola orchestrazione host, prompt, tool e surfacing.
Separazione:

```
src/
  core.ts              # invariato: logica pura (retrieve, score, applyConsolidation…)
  config.ts, store.ts  # invariati salvo schema v3
  engine/
    host.ts            # interfaccia Host (sotto)
    dream.ts           # build prompt, parse, dedup, apply (consolidate)
    surface.ts         # buildMemoryBlock(store, query, ctx) → string
    tools.ts           # definizioni dei tool memory_* sopra Host
  hosts/
    opencode.ts        # adapter V2: eventi, hook, registrazione, generate
  index.ts             # Plugin.define({ id, setup })
```

```ts
export interface Host {
  readonly name: "opencode"            // "claude-code" | "mcp" in futuro
  directoryFor(sessionID: string): Promise<string | undefined>
  generate(prompt: string, opts: { sessionID?: string; timeoutMs: number }): Promise<string>
  transcript(sessionID: string): Promise<TranscriptMessage[]>   // testo + tool part normalizzate
  lastUserText(sessionID: string): Promise<string>
  vcs?(directory: string): Promise<{ branch?: string; changed: ChangedFile[] } | undefined>
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void
}
```

`TranscriptMessage` normalizza le part `tool` (`{ tool, input }`), oggi perse in
`messageText()` come `[tool]`: servono a PR 3 e PR 4.

**Schema store v3** (solo tipi + migrazione, nessun uso ancora):

```ts
type Anchor = { path: string; symbol?: string; hash: string; anchoredAt: number }
// Entry += anchors?: Anchor[]
// Store  += version: 3; handoffs: Handoff[]   (Handoff definito in PR 4, qui come tipo)
```

`normalizeStore` porta v2 → v3 aggiungendo `handoffs: []`. Test di
round-trip: uno store v2 reale (fixture da `verify-runtime.ts`) viene letto,
scritto e riletto senza perdita.

Fatto quando: tutti i test esistenti verdi **senza modificarne le asserzioni**,
numeri del benchmark (`bun run bench --json`) identici byte per byte alla 1.7.2,
`verify:package` verde.

---

## PR 3 — ① Memorie ancorate al codice

### Modello

```ts
type Anchor = {
  path: string        // relativo alla root del progetto, separatori posix
  symbol?: string     // identificatore atteso nel file (opzionale)
  hash: string        // sha256 del contenuto al momento dell'ancoraggio (16 hex)
  anchoredAt: number
}
type AnchorState = "fresh" | "drifted" | "broken"
```

Solo le entry `scope: "project"` possono avere ancore (max 3 per entry).

Lo stato è **derivato e mai persistito come verità**: si ricalcola a ogni
lettura (con cache). Un file che manca su un altro branch torna `fresh` quando
si rientra nel branch: nessuna azione distruttiva automatica.

### Calcolo dello stato (`src/engine/anchors.ts`)

1. Risoluzione sicura: `path.resolve(projectDir, anchor.path)` + `realpath`
   deve restare dentro `realpath(projectDir)`. Rifiutati: path assoluti,
   `..` che escono, symlink che escono. **Mai leggere fuori dal progetto.**
2. File assente → `broken`.
3. File > 1 MB → hash di `size:mtime` invece del contenuto.
4. Hash uguale → `fresh`.
5. Hash diverso: con `symbol`, se il simbolo compare ancora (regex con
   escape e word boundary) → `drifted`, altrimenti `broken`; senza `symbol` →
   `drifted`.
6. Cache in memoria per `(path, mtimeMs, size)`.

Lo stato complessivo di un'entry è il peggiore fra le sue ancore.

### Comportamento

| Stato | SURFACE automatico | `memory_read` | DREAM |
|-------|-------------------|---------------|-------|
| fresh | normale | normale | normale |
| drifted | incluso con nota `(code changed since: src/x.ts)` | marcato `[drifted]` | nessuna azione |
| broken | **escluso** | marcato `[stale: src/x.ts#foo missing]` | segnalato al modello per verifica |

Le ancore si controllano solo sui candidati già usciti da `retrieve()`
(≤ `rerankCandidates`, default 30): I/O limitato per richiesta.

### Creazione delle ancore

- **Esplicita**: `memory_write` / `memory_update` accettano
  `anchors?: string[]` nel formato `"src/store.ts"` o `"src/store.ts#withLock"`.
  Ancore non valide → errore leggibile, il fatto non viene salvato
  (l'utente l'ha chiesto esplicitamente).
- **DREAM**: i fatti `new` possono avere `"anchors": ["path#symbol"]`. Il prompt
  elenca i file toccati nella sessione (dalle tool part normalizzate / vcs,
  secondo lo spike) come unici candidati ammessi. Ancore non valide → scartate,
  il fatto resta senza ancore.
- **Riconferma**: `memory_write` sullo stesso testo, `memory_update` e
  `memory_useful` ricalcolano gli hash → l'entry torna `fresh`.

### Verifica in DREAM

Le entry visibili con stato `broken` compaiono nel blocco entry del prompt come
`anchor=broken(src/x.ts#foo missing)`. Regole: entry `dreamed` → il modello può
fare `update` (nuova formulazione + nuova ancora) o `delete`; entry `explicit`
→ solo `conflicts` (il flusso CONFLICTED esistente), mai cancellazione.

### Tool

- `memory_inspect({ show: "stale" })`: elenco drifted + broken con motivo.
- `memory_why`: sezione `Anchors:` con stato e motivo di ogni ancora.

### Test e benchmark

- Unit: parsing `path#symbol`, path traversal e symlink escape rifiutati,
  quattro transizioni di stato, simbolo con caratteri regex, file > 1 MB,
  "file rimosso e poi ripristinato → di nuovo fresh".
- Integrazione nell'adapter con una directory di progetto temporanea.
- Benchmark: scenari "fatto con ancora rotta non viene mostrato" e "fatto
  drifted mostrato con nota"; nuova metrica **stale-surface rate**.

---

## PR 4 — ③ Handoff di sessione

### Modello

```ts
type Handoff = {
  id: string
  projectID: string                 // directory, stessa regola di isolamento dei fatti
  sessionID: string
  origin: { host: "opencode"; agent?: string }
  createdAt: number
  updatedAt: number
  branch?: string
  request?: string                  // ultima richiesta utente, max 300 char
  files: { path: string; status: "added" | "modified" | "deleted" }[]  // max 20
  todos?: { text: string; done: boolean }[]                             // se lo spike lo conferma
  narrative?: { goal: string; state: string; next: string[]; openQuestions: string[] }
  level: "mechanical" | "enriched"
  dismissedAt?: number
}
// Store.handoffs: ultimi 3 per progetto, tetto globale 50
```

### Due livelli (robusto anche se OpenCode viene chiuso subito)

1. **Meccanico, senza LLM, immediato**: all'evento di completamento della
   sessione (già intercettato per DREAM) si scrive o aggiorna l'handoff con
   branch, file toccati, ultima richiesta e todo. Non dipende dal debounce di
   90 s.
2. **Arricchito in DREAM, senza costo extra**: la stessa chiamata di
   consolidazione restituisce anche
   `"handoff": {"goal","state","next":[],"openQuestions":[]}` (oppure `null`
   per sessioni banali). Se `null` e non ci sono né file né todo, l'handoff
   meccanico viene rimosso (niente rumore per le sessioni di sole domande).

### SURFACE

Blocco `<handoff>` iniettato **solo** quando tutte queste condizioni valgono:
- è la prima richiesta di una sessione nuova nello stesso progetto;
- l'handoff viene da un'altra sessione, non è stato scartato, ha meno di
  `handoffMaxAgeHours` (default 72);
- `handoff` non è disattivato in config.

Il testo è morbido, per non dirottare la conversazione: *"The previous session
in this project ended as follows. Mention it only if the user's request relates
to it; do not assume they want to continue."* Se il branch corrente è diverso
→ nota `(written on branch X)`. Tetto `handoffMaxChars` (default 800), incluso
nel budget `maxChars`.

### Tool e config

- Nuovo tool `memory_handoff({ action: "show" | "list" | "dismiss", id? })`
  (decimo tool: aggiornare `MEMORY_TOOL_NAMES`, i test di registrazione e
  `verify:package`).
- `/memory resume` nel comando.
- Opzioni: `handoff` (bool, true), `handoffMaxAgeHours` (72),
  `handoffKeep` (3), `handoffMaxChars` (800), con le variabili `REM_MEMORY_*`.
- `memory_clear({ scope: "project" })` rimuove anche gli handoff del progetto;
  `memory_clear()` li rimuove tutti.

### Privacy e isolamento

- L'handoff è derivato dal transcript: stessa esposizione del summary. Regola
  nel prompt: niente segreti nell'handoff. Non contiene mai entry `local-only`.
- Un handoff del progetto A non deve mai comparire nel progetto B: stessa
  policy di `projectVisible`, con test di regressione dedicato.

### Test

Scrittura meccanica senza DREAM; arricchimento e merge; iniezione solo alla
prima richiesta; scadenza per età; dismiss; isolamento fra progetti;
`memory_clear`; sessione banale → nessun handoff.

---

## PR 5 — Comando nativo, documentazione, release

- Registrare `/memory` via `command.transform` (se lo spike lo conferma), così
  sparisce il passaggio manuale `curl … commands/memory.md`.
- README riscritto: posizionamento (memoria verificabile e pensata per il
  coding), ancore, handoff, **guida di migrazione 1.x → 2.0** (nome pacchetto,
  `plugins`, env, directory).
- CHANGELOG 2.0.0, `verify:package` con binario reale V2, publish `rem-memory`,
  deprecazione del vecchio pacchetto.

---

## Rischi

| Rischio | Mitigazione |
|---------|-------------|
| In Code Mode le modifiche ai file non sono visibili come tool part | Lo spike lo verifica; fallback `vcs.status` (delta fra inizio e fine sessione) |
| Progetto non git | Ancore funzionanti (basate su hash); handoff senza branch/file da vcs |
| Ogni modifica rende `drifted` | `drifted` produce solo una nota, nessuna penalità; l'esclusione avviene solo con `broken` |
| Cambio branch | Stato derivato, mai distruttivo; si ricalcola |
| L'handoff dirotta la conversazione | Solo alla prima richiesta, testo morbido, età massima, `dismiss`, opzione off |
| Lettura di file fuori dal progetto tramite ancore | Risoluzione con `realpath` e contenimento, test di path traversal |

## Esecuzione

- PR 1: worker-sonnet (multi-file meccanico con giudizio su test e script).
- PR 2: worker-sonnet con revisione stretta (refactor senza cambi di comportamento,
  verificato con benchmark identico).
- PR 3 e PR 4: due worker-sonnet in parallelo dopo la PR 2, su moduli separati;
  integrazione nell'adapter e revisione finale accentrate.
- Revisione di ogni diff, test e numeri del benchmark prima di ogni merge.
