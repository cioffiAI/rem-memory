# rem-memory

<video src="https://github.com/user-attachments/assets/b3b06cb6-0b63-4b18-a401-37964fe9e322" controls muted></video>

Local-first persistent memory for OpenCode (V2).

> rem-memory is the successor of `@cioffi_ai/opencode-memory`. Version 2 supports
> OpenCode V2 only; see [Upgrading from opencode-memory 1.x](#upgrading-from-opencode-memory-1x).

rem-memory gives OpenCode durable memory across sessions through a
WRITE → DREAM → SURFACE lifecycle:

- WRITE: explicit memory tools
- DREAM: headless conversation consolidation
- SURFACE: selective memory injection into future prompts

What sets it apart is that it is built to be checked and built for coding:

- **Auditable**: every memory records where it came from (explicit write or the
  session, messages and confidence of a dreamed fact), `memory_why` explains
  its ranking, and contradictions are flagged instead of silently overwritten.
- **Local-first**: plain JSON on your disk, no database, no cloud service;
  `local-only` facts never reach the model (see [Privacy](#privacy)).
- **Coding-specific**: [code-anchored memories](#code-anchored-memories) notice
  when the file or symbol they describe changes or disappears, and a
  [session handoff](#session-handoff) tells the next session in the same
  project where you left off.

## Features

- Local JSON storage with file locking, **zero external database**
- Explicit and inferred memory hierarchy with **auditable provenance**
  (each dreamed fact knows its source session, messages and confidence)
- **Memory Inspector**: `/memory` stats, conflicts, "why was this surfaced"
- **Contradiction lifecycle**: CONFLICTED explicit facts are flagged and
  resolved, never silently overwritten
- **Memory tiers**: core (always surfaced) / archival (on relevance) /
  temporary (auto-expiry) / pinned (never decays)
- **Hybrid retrieval**: lexical keyword pipeline + optional semantic
  reranking stage with abstention, relevance-gated surfacing
- **Retrieval feedback**: `memory_useful` / `memory_irrelevant` tune
  ranking from real usage
- **Per-memory privacy**: `local-only` facts stay on disk, out of every
  model-visible path (see [Privacy](#privacy) for the exact threat model)
- Global and project-scoped memories with enforced per-directory isolation,
  cross-language semantic deduplication
- **Session handoff**: a "where we left off" note that the next session of
  the same project receives once (see [Session handoff](#session-handoff))
- Tool-free internal generation for DREAM, dedup and reranking

## Project scope semantics

A project-scoped memory belongs to exactly one project directory
(`projectID` = the OpenCode session directory). The rules, enforced by a
single policy in `src/core.ts` (`projectVisible`, `readableEntries`,
`consolidationEntries`, `readQuery`) and covered by regression tests:

- Every model-facing tool (`memory_read`, `memory_update`, `memory_forget`,
  `memory_why`, `memory_useful`, `memory_irrelevant`, `memory_inspect`) sees
  global entries plus the CURRENT project's entries — never another
  project's.
- `memory_write` refreshes identical text only in the same scope (and
  the same project). A global fact and an equivalent project fact may coexist;
  neither suppresses the other. In that project both are retrievable,
  elsewhere only the global one.
- `memory_clear` with `scope: "project"` removes ONLY the current project's
  memories; other projects keep theirs. Without a scope it wipes everything
  (all projects, including local-only entries).
- DREAM consolidation for a session in project A can never suppress, merge
  with, rewrite, supersede or flag entries of project B (or local-only
  entries), even if the consolidation output references their ids.

## Installation

Add the package to your OpenCode configuration (`~/.config/opencode/opencode.json`
or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "rem-memory"
  ]
}
```

rem-memory targets OpenCode 2.0.18+ (V2). The OpenCode V1 adapter was removed
in 2.0; V1 users should stay on `@cioffi_ai/opencode-memory` 1.x.

OpenCode V2 exposes plugin tools through its Code Mode catalog by default (for example,
`tools.memory_read(...)` inside `execute`). This is normal: the ten memory
tools need not appear as ten standalone model tool definitions.

OpenCode installs npm plugins automatically via Bun on startup and caches them
in `~/.cache/opencode/node_modules/`. Restart OpenCode after adding the entry.

### The `/memory` command

The plugin registers a native `/memory` command (read, remember, update,
forget, `stats`, `conflicts`, `resume`, ...); there is nothing to copy. The
instructions it sends to the model are those of
[`commands/memory.md`](commands/memory.md), embedded at build time, followed
by whatever you type after `/memory`.

If you already keep your own `~/.config/opencode/commands/memory.md` (or a
project `.opencode/commands/memory.md`), that file **takes precedence**:
OpenCode 2.0.18 lists a single `memory` command, the one from the file, and
silently ignores the plugin's (no error, no warning; verified against the real
CLI). To avoid registering a command that can never run, set the option
`command: false` (or `REM_MEMORY_COMMAND=0`). The memory tools and the
automatic DREAM cycle work the same either way.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | Search facts (query / category / scope); multi-word queries match all terms; global + current project only |
| `memory_write` | Store an explicit fact; identical text refreshes it (`tier`, `ttlHours`, `pinned`, `sensitivity`, `anchors`) |
| `memory_update` | Correct a fact, by `id` or match — resolves CONFLICTED entries; `anchors` replaces its code anchors |
| `memory_forget` / `memory_clear` | Remove facts; `memory_clear({ summaryOnly: true })` clears only the shared summary |
| `memory_why` | Audit a memory: provenance, lifecycle, score breakdown, code anchors |
| `memory_inspect` | `stats` \| `recent` \| `conflicts` \| `project` \| `surfaced` \| `stale` (code-anchored memories that drifted or broke) |
| `memory_useful` / `memory_irrelevant` | Feedback on retrieval quality |
| `memory_handoff` | `show` \| `list` \| `dismiss` (`id`): session handoffs of the current project only |

`memory_write` retains distinct facts even when they share similar wording or
are submitted together with `Promise.all`. Repeating the same text (ignoring
case and whitespace) refreshes the existing entry; punctuation and technical
symbols remain significant. Use `memory_update` with the entry's `id` to
correct a fact. DREAM still checks inferred facts for semantic duplicates.

`memory_read` uses its own conservative lexical search: the historical
contiguous substring match is preserved, plus an all-terms path where every
term of a multi-word query must appear as a whole token (any order,
non-contiguous) in the text or category. Query and memory go through the same
identifier grammar: a camelCase word matches either its compact or its
separated spelling (`JavaScript` ↔ `javascript` / `java script`, never one
half alone). Short and technical terms are kept (`AI`, `UI`, `DB`, `C`, `R`,
`no`, `C++`, `C#`, `Node.js`, `.NET`); no stemming, synonyms or accent
folding. Scope/category filters, score ordering and privacy rules are
identical to the rest of the plugin.

Example of `memory_why`:

```text
Text:    The user prefers Bun over npm.
Source:  explicit (via memory_write)
Lifecycle: ACTIVE | tier core | pinned (no decay)
Score (now): 3.512 = (3.00 + source bonus + utilization) × decay 1.000
Last surfacing (session abc):
  Base score:   3.51
  Keyword match: +3.00 (1 hits)
  Core bonus:    yes
  Final rank:    #2
```

## Code-anchored memories

A project fact can point at the code it is about. Pass `anchors` to
`memory_write` or `memory_update` (project scope only, at most 3 per entry):

```text
memory_write({ fact: "withLock serializes all store writes.", scope: "project",
               anchors: ["src/store.ts#withLock"] })
```

An anchor is `path` or `path#symbol`, relative to the project. It records a
hash of the file at that moment. The state is **derived on every read and never
stored**, so switching branches back and forth is harmless:

| State | When | Effect |
| --- | --- | --- |
| `fresh` | the file is unchanged | normal |
| `drifted` | the file changed (and the symbol, if any, is still there) | still surfaced, with the note `(code changed since: src/store.ts)`; `memory_read` shows `[drifted]` |
| `broken` | the file is gone, or the symbol no longer appears in it | not surfaced automatically; `memory_read` shows `[stale: src/store.ts#withLock symbol missing]` |

An entry's state is the worst of its anchors. `memory_inspect({ show: "stale" })`
lists drifted and broken memories; `memory_why` has an `Anchors:` section.
Re-confirm a memory with `memory_useful`, `memory_update` or by repeating the
same `memory_write`: the hashes are recomputed and the entry is fresh again
(if the file is still missing, the old anchor is kept and stays stale).

- Paths are resolved with `realpath` and must stay inside the project:
  absolute paths, `..` and symlinks that leave the project are rejected, and
  nothing outside the project is ever read. An invalid anchor on an explicit
  write returns an error and saves nothing.
- Files over 1 MB are compared by size and modification time instead of content.
- DREAM may attach anchors to new project facts, but only to files touched in
  the session (and only if the file and symbol exist); invalid ones are
  dropped and the fact is kept. Broken anchors are flagged to the model as
  `anchor=broken(...)`: dreamed entries may be updated or deleted, explicit
  ones are never deleted (conflicts only).
- Anchors are checked only for the few candidates about to be shown, so the
  per-request cost stays small. Entries without anchors behave exactly as before.

## Session handoff

When a session completes, rem-memory immediately writes a **mechanical**
handoff (no model call): the files the session touched (from OpenCode's
snapshot, falling back to edit/write/patch tool inputs outside git), their
status from `vcs`, the current branch and the last user request. Sessions that
touched no files leave nothing behind. The next DREAM pass **enriches** it for
free, in the same call, with a short narrative (`goal`, `state`, `next`,
`openQuestions`) or removes it when the session was trivial and touched no
files. There is one handoff per session; the newest `handoffKeep` per project
are retained.

The next session in the **same project directory** receives a `<handoff>`
block, inside the `<memory>` block, only on its first request, only once, only
if the handoff comes from another session, is not dismissed and is younger than
`handoffMaxAgeHours`. The text is deliberately soft ("mention it only if the
user's request relates to it") and notes the original branch when it differs
from the current one. The handoff gets at most `handoffMaxChars` (and never
more than half of `maxChars`); the summary and facts are trimmed to the
remaining room so the whole block still fits in `maxChars`. Use
`memory_handoff` to `show` the latest, `list` all, or `dismiss` one, and
`/memory resume` to pick up where you left off.

Privacy: handoffs are derived from the transcript like the summary, the DREAM
prompt forbids secrets in them, and `local-only` entries never enter one.
A project's handoffs are never visible from another project.
`memory_clear({ scope: "project" })` removes the project's handoffs and
`memory_clear()` removes all of them; `scope: "global"` and `summaryOnly` leave
them untouched.

## Recency, exposure and feedback

Time-based decay is computed from `lastSeen` — the last time a fact was
CONFIRMED (explicit write/update, consolidation refresh, or positive feedback
via `memory_useful`). Automatic surfacing updates only exposure counters
(`lastSurfaced`, `surfacedCount`): being shown to the model is not evidence
that a fact is still true, so exposure never resets decay and cannot make a
frequently-surfaced memory immortal under pruning. Negative feedback
(`memory_irrelevant`) lowers ranking without touching recency.

## Configuration

Configure the plugin in `opencode.jsonc` with an object entry:

```jsonc
{
  "plugins": [{
    "package": "rem-memory",
    "options": {
      "dream": false,
      "surface": false,
      "summary": false
    }
  }]
}
```

Every setting below accepts a typed plugin option. An option takes precedence
over its environment variable; otherwise the environment variable or default
applies. Environment booleans use `1`/`0` (for `off`, `debug` and `rerank` any value other than `1` means off), while JSONC options use `true`/`false`.
Numeric options must be integers. Unknown or invalid options fail plugin setup
with the offending name instead of silently falling back.

| Option | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `off` | `REM_MEMORY_OFF` | false | Disable the entire plugin. |
| `dream` | `REM_MEMORY_DREAM` | true | Automatic conversation consolidation and recovery sweep. |
| `surface` | `REM_MEMORY_SURFACE` | true | Automatic memory injection and semantic reranking. |
| `summary` | `REM_MEMORY_SUMMARY` | true | Generate and expose the shared summary in automatic context and `memory_read`. |
| `dir` | `REM_MEMORY_DIR` | `~/.local/share/rem-memory` | Store, state and summary directory. |
| `debug` | `REM_MEMORY_DEBUG` | false | Trace logging. |
| `delayMs` | `REM_MEMORY_DELAY_MS` | 90000 | Idle debounce before DREAM. |
| `maxEntries` | `REM_MEMORY_MAX_ENTRIES` | 400 | Maximum retained memories. |
| `maxFacts` | `REM_MEMORY_MAX_FACTS` | 18 | Maximum relevance-ranked facts in a prompt. |
| `maxChars` | `REM_MEMORY_MAX_CHARS` | 2400 | Maximum memory-block characters. |
| `transcriptChars` | `REM_MEMORY_TRANSCRIPT_CHARS` | 12000 | Maximum transcript characters sent to DREAM. |
| `sweepIntervalMs` | `REM_MEMORY_SWEEP_MS` | 600000 | Recovery sweep interval. |
| `sweepStartMs` | `REM_MEMORY_SWEEP_START_MS` | 20000 | Delay before first recovery sweep. |
| `sweepBatch` | `REM_MEMORY_SWEEP_BATCH` | 8 | Maximum sessions processed per sweep. |
| `gcChildAgeMs` | `REM_MEMORY_GC_CHILD_AGE_MS` | — | Deprecated and ignored (V1 only). Still accepted so existing configs load; a warning is logged. |
| `inProgressTimeoutMs` | `REM_MEMORY_INPROGRESS_TIMEOUT_MS` | 600000 | Expiry of a DREAM in-progress marker. |
| `rerank` | `REM_MEMORY_RERANK` | false | Optional model-based relevance reranking. |
| `rerankCandidates` | `REM_MEMORY_RERANK_CANDIDATES` | 30 | Candidate window for reranking. |
| `rerankTimeoutMs` | `REM_MEMORY_RERANK_TIMEOUT_MS` | 4000 | Rerank timeout before lexical fallback. |
| `rerankCacheMs` | `REM_MEMORY_RERANK_CACHE_MS` | 60000 | Rerank cache lifetime. |
| `coreSlot` | `REM_MEMORY_CORE_SLOT` | 3 | Core-tier entries injected beyond relevance matches. |
| `surfaceRefreshMs` | `REM_MEMORY_SURFACE_REFRESH_MS` | 900000 | Minimum interval between persisted exposure updates. |
| `command` | `REM_MEMORY_COMMAND` | true | Register the native `/memory` command. Set `false` if you keep your own `memory.md` command file. |
| `handoff` | `REM_MEMORY_HANDOFF` | true | Session handoff: mechanical write, DREAM enrichment and first-request injection. `false` disables all three; `memory_handoff` still reads existing data. |
| `handoffMaxAgeHours` | `REM_MEMORY_HANDOFF_MAX_AGE_HOURS` | 72 | Older handoffs are no longer injected (still listed by `memory_handoff`). |
| `handoffKeep` | `REM_MEMORY_HANDOFF_KEEP` | 3 | Handoffs kept per project (newest first); 50 overall. |
| `handoffMaxChars` | `REM_MEMORY_HANDOFF_MAX_CHARS` | 800 | Maximum characters of the injected `<handoff>` block (at most half of `maxChars`). |

**Legacy environment variables.** The pre-2.0 `OPENCODE_MEMORY_*` names (same
suffixes, for example `OPENCODE_MEMORY_DREAM`) are still read as a fallback,
with a single deprecation warning per process listing the legacy names in use.
If both are set, `REM_MEMORY_*` wins.

**Data directory and migration.** The default directory is
`~/.local/share/rem-memory` (previously `~/.local/share/opencode/memory`). When
`dir` is not set explicitly (neither option nor environment variable), the new
directory has no `store.json` and the old one does, the plugin copies
`store.json`, `state.json` and `SUMMARY.md` into the new directory under the
store lock and writes a `MIGRATED_TO_REM_MEMORY` marker in the old directory.
The old files are never deleted or modified. An explicit `dir` is never
migrated.

Use an absolute `dir` path when overriding the store location. Each plugin
instance uses its own resolved options and store path. Changing `dir` selects a
different store; it does not move data from the old directory.

Set `REM_MEMORY_DREAM=0` to stop automatic consolidation and its model calls. Set
`REM_MEMORY_SURFACE=0` to stop automatic prompt injection; this also prevents
semantic reranking even if `REM_MEMORY_RERANK=1`. Either setting leaves the
explicit memory tools available. `REM_MEMORY_OFF=1` disables the entire plugin.
These switches do not prevent OpenCode itself or explicit tool calls from sending
conversation content to the configured model provider.

### Disable or clear the summary

Set `summary: false` (or `REM_MEMORY_SUMMARY=0`) to hide the summary from
automatic context and `memory_read`, and stop DREAM from generating or updating
it. Facts remain available through the tools and, when enabled, SURFACE.
Disabling the summary preserves it on disk, so re-enabling the option restores
it. This option is useful when DREAM is disabled and the summary becomes stale.

To erase the stored summary while keeping every fact, call:

```js
await tools.memory_clear({ summaryOnly: true })
```

The summary is shared across projects, so `summaryOnly` cannot be combined with
`scope`. If `summary` remains enabled, a later DREAM can generate it again.

## Retrieval semantics (v1.6)

The lexical pipeline is a small, independently testable chain:

tokenizer → keyword extraction → alias expansion → candidate generation
(scope/status/sensitivity filter) → boundary-safe matching → scoring →
**relevance gate** → surface (+ optional semantic rerank with abstention).

Matching rules, enforced in `src/core.ts` and covered by regression tests:

- **Token boundaries are sacred.** A keyword matches whole normalized tokens
  only. `use` never matches `user`, `test` never matches `pytest`/
  `greatest`, `red` never matches `redesign`. Bare substring and open-ended
  prefix matching were removed in v1.6.
- **Identifiers are first-class.** camelCase/PascalCase split at case
  boundaries (`userStore` → `user` + `store`); snake_case, kebab-case,
  dotted names and paths split on their separators. Both the whole compound
  (`javascript`) and its parts match.
- **Morphology is explicit and small**: plural (`deploy`↔`deploys`), gerund
  (`network`↔`networking`) and participle (`test`↔`tested`) forms match in
  both directions. Nothing else.
- **Synonym groups contain only substitutable terms** (translations,
  aliases, abbreviations of the SAME concept: `colore`↔`color`,
  `job`↔`lavoro`, `db`↔`database`). Opinion verbs (`like`, `prefer`,
  `favorite`…) are not synonyms of anything and no longer bridge domains.
- The **relevance gate** is a named single-source predicate
  (`passesRelevanceGate`): candidates without at least one boundary-safe
  match never enter the injected block; the core slot stays contractual.
- Every surfacing decision is explainable: `retrieve()` returns per-keyword
  provenance (`keyword:kind via query-term`), and
  `bun run bench --explain-negatives` dumps it machine-readably.

## Retrieval benchmark

Two scenario sets, one harness (`bench/lib.ts`):

- **DEV/REGRESSION set** (115 scenarios: 77 positive / 38 negative across six
  negative categories) — used while developing; its positives are frozen
  since v1.5.0 and must never be edited to flatter the algorithm.
- **HELD-OUT set** (20 scenarios) — written once from the feature contract
  BEFORE the v1.6 fixes were implemented and not iterated against. It
  includes identifier/package-name/path traps, bilingual weak associations,
  related-tech-wrong-fact and declared CEILING-MEASURE cases.

Metrics (identical in human and `--json` output): Recall@1, Recall@5, MRR
(candidate quality, before any gate), macro and entry-level surface
precision, false-abstention rate on positives, query-level false-positive
rate with memory-level counts, abstention breakdown for negatives (fully
abstained / core-slot only / irrelevant non-core surfaced), Wilson 95%
confidence intervals, average surfaced memories and context overhead.

Current results (lexical pipeline, reranker disabled):

```text
DEV set     Recall@5 100% · MRR 95.2% · surface precision 63.2% macro /
            81.8% entry-level (54/66) · FPR 34.2% (13/38) · overhead 9.1 tok
HELD-OUT    Recall@5 100% · MRR 100%  · FPR 26.7% (4/15) · 0 false abstentions
            (v1.5.1 algorithm measured on the same held-out set: FPR 46.7%,
             7/15, including every identifier/substring trap)
```

Interpretation: all remaining negative-scenario failures are exact-token or
true-translation matches whose INTENT differs ("test account" vs test
framework question, "server in the basement" vs MCP server configuration,
relational facts like "the brother repairs phones"). No mechanical matching
bug remains in either set. This is the honest ceiling of zero-dependency
lexical retrieval; the mitigation path already shipped is the optional
semantic reranker with abstention (`REM_MEMORY_RERANK=1`). Embeddings
are NOT yet justified by this evidence: the residual errors are intent/attribution
problems, which bag-of-embeddings only partially addresses.

## Privacy

Memory files are always stored locally (JSON + lockfile, no external database,
no plugin cloud service).

During DREAM consolidation, the conversation transcript is processed by the
model provider configured in OpenCode. That provider may be local (e.g.
Ollama) or remote (a cloud API): if remote, conversation text is sent to that
provider through the same channels OpenCode already uses — this plugin cannot
change that. For sensitive conversations use a local provider or set
`REM_MEMORY_OFF=1`.

### `local-only` memories: exact guarantee

Facts written with `sensitivity: "local-only"` are stored on disk only. The
plugin never includes them in ANY model-visible path:

- not in the automatic `<memory>` block (SURFACE injection),
- not among DREAM prompt entries nor the semantic dedup prompt,
- not among semantic rerank candidates,
- not returned by `memory_read`, `memory_why` or any `memory_inspect` view,
- not mutable through `memory_update`, `memory_forget`, `memory_useful`,
  `memory_irrelevant` (they are invisible to all of them).

They are therefore inaccessible to the model in every later session; the only
supported access path is direct file inspection by the human user
(`store.json` / `SUMMARY.md` in `REM_MEMORY_DIR`). Use them as a durable
local record of secrets that must never propagate to new contexts.

Two limitations remain, by architecture rather than by omission:

1. The WRITE call itself necessarily passes through the model (it is a tool
   call), and if the fact was typed in the conversation, the transcript has
   already reached the provider. `local-only` prevents RE-exposure in future
   sessions; it cannot retract what already left the machine.
2. The generated summary is derived from the transcript by the provider; the
   DREAM prompt forbids sensitive data in summaries, but the plugin cannot
   technically guarantee what a remote model writes there.

## DREAM containment

Consolidation, semantic dedup and semantic rerank run through
`ctx.session.generate()` on the finished session. It writes no conversation
history and never executes tool calls: it returns text only (checked against
OpenCode 2.0.18 with a prompt that demanded a file write; no file was written).
rem-memory's own `generate` hook strips the session's system prompt and
conversation from these requests, so the model sees only the internal prompt.
Tool *definitions* are stripped too, except on the `opencode` provider, whose
free tier rejects requests without them ("OpenCode's free tier can only be used
from within OpenCode"); there they stay visible but cannot be executed. Without
a session, `ctx.generate.text()` is used. No helper sessions are created, so
there is nothing to hide or garbage-collect. A periodic recovery pass uses the
durable two-phase `inProgress` journal to retry interrupted consolidations
after the configured timeout.

## Upgrading from opencode-memory 1.x

rem-memory 2.0 is the next major version of `@cioffi_ai/opencode-memory`
(1.x), published under a new name and for OpenCode V2 only.

1. **Package name.** In the `plugins` array of your OpenCode configuration
   replace `"@cioffi_ai/opencode-memory"` with `"rem-memory"` (or, with
   options, `"package": "rem-memory"`).
2. **OpenCode V1 is no longer supported.** The V1 adapter was removed. If you
   still run OpenCode V1, stay on `@cioffi_ai/opencode-memory` 1.x.
3. **Environment variables.** `OPENCODE_MEMORY_*` became `REM_MEMORY_*` (same
   suffixes). The old names still work as a fallback and log one deprecation
   warning per process; when both are set, `REM_MEMORY_*` wins.
4. **Data directory.** The default moved from `~/.local/share/opencode/memory`
   to `~/.local/share/rem-memory`. On first start, if you did not set `dir`
   (option or environment) and the new directory has no `store.json`, the
   plugin copies `store.json`, `state.json` and `SUMMARY.md` there and leaves a
   `MIGRATED_TO_REM_MEMORY` marker in the old directory. The old directory is
   never modified or deleted. If you set `dir` explicitly nothing is migrated:
   2.0 simply opens that directory.
5. **Removed option.** `gcChildAgeMs` (and `REM_MEMORY_GC_CHILD_AGE_MS`) is
   accepted but ignored, with a warning: 2.0 creates no helper sessions to
   garbage-collect. Remove it from your configuration.
6. **The `/memory` command is now built in.** Delete the manual
   `commands/memory.md` copy to use the plugin's, or keep it and set
   `command: false` (a file command wins over the plugin's anyway; see
   [The `/memory` command](#the-memory-command)).
7. **New in 2.0.** Tools and options: `anchors` on `memory_write` /
   `memory_update`, `memory_inspect({ show: "stale" })`, the `memory_handoff`
   tool (ten tools in total), and the options `handoff`, `handoffMaxAgeHours`,
   `handoffKeep`, `handoffMaxChars` and `command`. See
   [Code-anchored memories](#code-anchored-memories) and
   [Session handoff](#session-handoff).
8. **Old local plugin folders.** OpenCode loads every directory in
   `~/.config/opencode/plugins/` automatically, even when it is not listed in
   your configuration. If you kept a local copy of the 1.x plugin there, move
   it out, otherwise two memory plugins run side by side.

**Store format and going back.** 2.0 writes store schema version 3 (additive:
`anchors` on entries, `handoffs` on the store). 2.0 reads 1.x stores
(versions 1 and 2) and upgrades them to 3. The reverse does not
hold: 1.x only accepts versions 1 and 2 and treats anything else as an empty
store, so a 1.x process pointed at a directory written by 2.0 sees no memories
and its next write can replace the file. With the default directories this cannot
happen (1.x keeps using the untouched old directory, so you can roll back and
simply lose what 2.0 learned), but do not share an explicit `dir` between 1.x
and 2.0, and back up `store.json` before trying 2.0 on a shared directory.

## Roadmap

- **2.1**: reuse the host-neutral engine from other agents: an MCP server for
  the tools and a Claude Code adapter (hooks for SURFACE and DREAM) sharing the
  same local store, so a session handoff written in one agent is picked up in
  another.
- **Later**: lessons learned from failed tool calls, surfaced before the next
  attempt; a review inbox for low-confidence DREAM facts; SQLite storage for
  concurrent multi-agent writers.

## Development

```bash
bun install
bun run check           # typecheck + tests + build
bun run verify:package  # pack + clean install + tool/runtime checks
bun run bench           # retrieval benchmark
npm pack --dry-run
```

To check the actual packaged artifact against a real OpenCode V2 CLI, point the
check at an existing binary (it never downloads or replaces a CLI):

```bash
OPENCODE_TEST_BIN_V2=/path/to/opencode-v2 bun run verify:package
```

The runtime check uses a temporary profile and a deterministic model served on
localhost; no AI credentials or paid model calls are needed. It checks
loading, all ten tool registrations, the native `/memory` command, write/read,
context injection, automatic DREAM, store migration and local-only privacy. Logs and request evidence stay in
the printed temporary directory. The default unit test suite does not replace
this opt-in runtime check.

## License

MIT — see [LICENSE](LICENSE).
