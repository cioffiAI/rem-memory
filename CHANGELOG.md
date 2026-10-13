# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.0.0-beta.0] — unreleased

### Added

- Session handoff: a mechanical "where we left off" note (touched files, branch,
  last request) written as soon as a session completes, optionally enriched by
  DREAM with a goal/state/next/open-questions narrative, and injected once into
  the first request of the next session of the same project.
- `memory_handoff` tool (`show`, `list`, `dismiss`); 10 tools in total.
- Options `handoff`, `handoffMaxAgeHours`, `handoffKeep`, `handoffMaxChars`
  (`REM_MEMORY_HANDOFF*`).
- `/memory resume` in `commands/memory.md`.

### Changed

- `memory_clear({ scope: "project" })` also removes the project's handoffs and
  `memory_clear()` removes all of them.
- The DREAM prompt gains a handoff task only while `handoff` is enabled; with
  `handoff: false` it is unchanged.

## [2.0.0-alpha.2] — unreleased

### Added

- Code-anchored memories: `anchors` (`"path"` or `"path#symbol"`, max 3) on
  `memory_write` and `memory_update` for project facts. Anchor state
  (`fresh` / `drifted` / `broken`) is derived on demand from a content hash and
  symbol check and never persisted. Drifted facts are surfaced with a
  `(code changed since: …)` note; broken ones are left out of the automatic
  block. New module `src/engine/anchors.ts`.
- `memory_inspect({ show: "stale" })`, `[drifted]` / `[stale: …]` markers in
  `memory_read`, and an `Anchors:` section in `memory_why`.
- DREAM can anchor new project facts to files touched in the session and is
  told about broken anchors (`anchor=broken(…)`); explicit entries stay protected.
- `memory_write` (same text), `memory_update` and `memory_useful` re-anchor.

### Security

- Anchor paths are resolved with `realpath` and must stay inside the project;
  traversal, absolute paths and escaping symlinks are rejected.

## [2.0.0-alpha.0] — unreleased

### Removed

- OpenCode V1 adapter (`server()` export, `src/v1.ts`, headless child sessions,
  orphan GC), the V1-only `src/rerank.ts`, and the `@opencode-ai/plugin`
  dependency. V1 users should stay on `@cioffi_ai/opencode-memory` 1.x.
- `gcChildAgeMs` no longer has any effect (see Changed).
- The `./server` export and `server.js`: OpenCode V2 loads the package through
  its main `"."` export.

### Changed

- Package renamed to `rem-memory` (plugin id `cioffi.rem-memory`, log prefix
  `[rem-memory]`, `SUMMARY.md` heading `# rem-memory summary`). Tool names
  `memory_*` are unchanged.
- Environment variables are now `REM_MEMORY_*`. The old `OPENCODE_MEMORY_*`
  names are read as a fallback with one deprecation warning per process;
  `REM_MEMORY_*` wins when both are set.
- Default data directory is `~/.local/share/rem-memory`.
- `gcChildAgeMs` is still accepted and validated but ignored; setting it logs
  a deprecation warning.

### Added

- One-time migration of `store.json`, `state.json` and `SUMMARY.md` from
  `~/.local/share/opencode/memory` when `dir` is not set explicitly and the new
  directory has no store. A `MIGRATED_TO_REM_MEMORY` marker is written in the
  old directory; old files are never deleted.

## [1.7.2] — 2026-09-30

### Added

- `summary` plugin option and `OPENCODE_MEMORY_SUMMARY` switch to disable summary
  generation and hide stored summaries from context and memory tools (issue #12).
- `memory_clear({ summaryOnly: true })` erases the shared summary while retaining
  all facts (issue #12).

### Fixed

- Explicit writes no longer overwrite distinct facts with similar wording,
  including the two preferences in Jack's parallel-write example (issue #11).
  Identical text still refreshes an entry; corrections use `memory_update`.
- Store mutations queue across instances sharing a directory, preventing local
  parallel calls from exhausting lock retries while retaining cross-process
  file locking (issue #11).

## [1.7.1] — 2026-09-29

### Added

- Independent DREAM and SURFACE switches, with explicit memory tools still
  available when either automatic process is disabled (issue #8).
- Typed plugin options in `opencode.jsonc` for every memory setting, with
  per-instance configuration and store paths in both V1 and V2 (issue #9).

## [1.7.0] — 2026-09-28

OpenCode V2 compatibility (issue #6), retaining OpenCode V1 1.18.29+ support.

### Added

- Native OpenCode V2 adapter with `id`/`setup`, event subscription, context
  hook and all nine `memory_*` tools registered through JSON Schema.
- One hybrid package entrypoint: OpenCode V2 uses `setup`, while OpenCode V1
  1.18.29+ uses `server`; both adapters share the 1.6 store and core logic.
- Clean-install checks for both runtime contracts and a dedicated V2 test for
  DREAM consolidation, context injection, privacy and disposal.
- Opt-in real CLI checks with isolated profiles and a deterministic local model,
  including tool execution, automatic consolidation and legacy store migration.

### Fixed

- OpenCode V2 no longer rejects the package's default export at startup.
- V2 DREAM listens to native `session.execution.*` completion events as well
  as the legacy idle event. Events without a directory are checked against the
  session's project before scheduling consolidation.
- V2 unload and partial setup failure dispose tool and context registrations.

### Changed

- V2 DREAM, semantic deduplication and reranking use isolated
  `ctx.generate.text()` calls, which create no helper sessions and expose no
  tools. V1 keeps its existing allow-none child-session implementation.
- Package metadata now exposes the conventional `./server` entrypoint needed
  when OpenCode V2 loads an installed package directory directly.

## [1.6.0] — 2026-09-18

Retrieval Evaluation / Relevance. Retrieval semantics change (user-visible);
API compatible. No new features; no new packages (the plugin's runtime
dependency is now declared correctly, see below).

### Fixed

- **`memory_read` multi-term queries (issue #4).** `readQuery` keeps the
  legacy contiguous substring match and adds an all-terms whole-token path:
  `coffee morning` matches "coffee in the morning" (any order,
  non-contiguous) while short and technical terms are not dropped (`AI`,
  `UI`, `DB`, `C`, `R`, `no`, `C++`, `C#`, `Node.js`, `.NET`). No stemming,
  synonyms or accent folding; scope/category filters, score ordering and the
  privacy policy are unchanged. Covered by `tests/read-query.test.ts`.
- **Identifier tokenization is symmetric in `memory_read`.** Query and memory
  go through the same word grammar: a camelCase identifier matches its compact
  form OR all of its case-boundary parts, so `JavaScript` matches both
  "JavaScript" and "javascript"/"java script" and `userStore` matches
  "user store" (one half alone never satisfies it; query casing cannot change
  the outcome). Same coverage in `tests/read-query.test.ts`.
- **Unsafe substring matching removed.** The matcher now respects token
  boundaries: `use` no longer matches `user`, `test` no longer matches
  `pytest`/`greatest`, `red` no longer matches `redesign`. Confirmed by the
  v1.5.1 evidence file `bench/evidence/v1.5.1-fp-taxonomy.json`.
- **Synonym groups restricted to substitutable terms.** Opinion/preference
  verbs were removed from the color group (they bridged "color" queries to
  unrelated "favorite X" facts); `design` and `project` families are split;
  the standalone Italian word `banca` no longer expands to database terms;
  the dead phrase member `"sistema operativo"` was dropped.
- **camelCase identifiers tokenize correctly**: the boundary splitter only
  splits at lowercase→uppercase transitions ("RAM", "GB" stay whole;
  "userStore"/"JavaScript" produce both parts and the whole form).
- **Runtime dependency declared (issues #2/#3).** `@opencode-ai/plugin` is
  imported at load time by the published `dist/index.js`, so it moved from
  `devDependencies` to `dependencies`: a clean install of the tarball now
  resolves it. New release gate `bun run verify:package` (wired into
  `prepublishOnly`) builds, packs, installs the tarball outside the checkout,
  imports it by package name, asserts the nine `memory_*` tools are
  registered and calls `dispose()` to release the timers.

### Changed

- **Candidate generation is separated from surfacing relevance.**
  `retrieve()` returns high-recall candidates; a named single-source
  relevance gate (`passesRelevanceGate`) decides what enters the injected
  block, shared by the plugin and the benchmark harness.
- **Every match carries provenance** (`keyword`, `kind`
  exact/inflection/category, `direct`, `via` query term):
  `bun run bench --explain-negatives [--heldout] [--fp-only]` emits the full
  machine-readable taxonomy of what surfaced and why.
- **Morphology is explicit**: plural s/es/ies, gerund -ing and participle -ed
  match in both directions; nothing else does.
- **Reranker extracted to `src/rerank.ts`** with an injectable client:
  abstention, invalid-answer fallback, timeout fallback, per-query caching,
  zero-tool containment propagation and local-only filtering are unit-tested
  with deterministic fakes (`tests/reranker.test.ts`). Behavior unchanged.
- **Benchmark**: added Recall@1, entry-level surface precision with pooled
  counts, false-abstention rate on positives, memory-level FP counts,
  negative-outcome breakdown (abstained / core-only / non-core surfaced),
  Wilson 95% confidence intervals, average memories surfaced; separate
  HELD-OUT evaluation set (`bench/scenarios-heldout.ts`, `--heldout`)
  written before the fixes and not iterated against.

### Measured (lexical pipeline, reranker disabled)

| metric | v1.5.1 | v1.6.0 |
| --- | --- | --- |
| Recall@5 (dev) | 100% | 100% |
| MRR (dev) | 95.2% | 95.2% |
| Surface precision macro (dev) | 65.8% | 63.2% |
| FPR negative queries (dev) | 39.5% (15/38) | 34.2% (13/38) |
| FPR held-out | 46.7% (7/15) | 26.7% (4/15) |
| False abstentions (dev) | 26.0% (20/77) | 31.2% (24/77) |

The four new false abstentions (kw-02, pa-10, co-05, ob-05) all relied on the
removed substring behavior: `use` matching inside the universal "user" token
(kw-02, co-05, ob-05) and `uni` matching inside "university" (pa-10).
All 13 remaining dev-set failures are exact-token or true-translation matches
whose intent differs — documented as the lexical ceiling; embeddings are NOT
yet justified by this evidence.

## [1.5.1] — 2026-08-26

Trust-boundaries hardening release. No new features; every change tightens an
existing guarantee.

### Fixed

- **Project isolation enforced end-to-end.** `memory_read` previously returned
  project-scoped entries of ALL projects (no directory filter); the `project`
  inspector view listed other projects' entries; `memory_clear(scope="project")`
  deleted every project's memories, not just the current project's;
  `memory_update` / `memory_forget` / feedback tools could mutate another
  project's entries by id or text match. All lookups now go through a single
  visibility policy (`readableEntries` / `readQuery` / `clearProjectEntries` in
  `core.ts`): global + current project only. Regression-tested with two
  distinct directories plus global entries.
- **DREAM cross-project contamination.** Consolidation dedup searched the whole
  store: a fact extracted in project A could refresh/rewrite project B's
  dreamed entry, be suppressed by B's explicit entry via similarity or topic
  clash, or update/supersede/flag entries it was never shown. All consolidation
  lookups are now restricted to the consolidating session's visible set.
- **`memory_write` rewrite targeting.** A write with an explicit scope could
  overwrite a semantically similar entry from a DIFFERENT scope/project;
  rewrite-dedup is now same-scope + same-project only (global and equivalent
  project facts coexist by design).
- **Relevance gate silently defeated.** The word "user" (and "utente") was not
  in the retrieval stopword list while nearly every stored fact contains it, so
  any query mentioning "user" matched every entry and the keyword relevance
  gate introduced in 1.5.0 never actually gated anything. Found by the new
  falsifiable benchmark (negative-query FP rate dropped from 76.3% to 39.5%
  after the fix, Recall unchanged at 100%).

### Changed

- **Surfacing no longer refreshes recency.** Automatic exposure used to bump
  `lastSeen`, letting frequently surfaced memories stay artificially fresh
  (a self-reinforcing retrieval loop, immortal under pruning). Exposure is now
  recorded separately (`lastSurfaced`, `surfacedCount`) and never affects the
  score; only explicit confirmation (`memory_useful`, writes,
  consolidation refreshes) resets decay. Negative feedback never touches
  recency.
- **Semantic reranker can abstain.** With `OPENCODE_MEMORY_RERANK=1` the
  reranker may answer `{"order":[]}` when no candidate answers the question;
  abstention surfaces nothing beyond the core slot instead of forcing a
  ranking. Unparseable output still falls back to the deterministic lexical
  order. Rerank orphan children are now garbage-collected like consolidation
  ones.
- **Falsifiable benchmark.** `bench/run.ts` rewritten around a pure harness:
  the old "false-surface rate" counted unsupported surfacing AFTER the keyword
  gate had already filtered those entries (0.0% by construction). The suite now
  has 38 negative scenarios across six categories that can genuinely fail
  (clean no-match, hard lexical negatives, semantic distractors, cross-language
  collisions, project-isolation negatives, core-only queries) and reports
  separately candidate quality (Recall@5, MRR), surface precision, false-
  positive / abstention rate and context overhead. Positive scenarios are
  unchanged.

### Security

- **DREAM child sessions run with zero tools.** The headless consolidation,
  semantic-dedup and rerank sessions previously disabled only the five memory
  tools by name — shell, filesystem, network fetch, MCP and subagent tools
  remained available to a session processing untrusted conversation text.
  They are now created with a single wildcard denial (`tools: {"*": false}`),
  verified against OpenCode server source v1.18.0–v1.18.20 to remove the
  entire toolset from the model-visible request (allow-none). Crash recovery,
  orphan GC and at-least-once semantics are unchanged. A contract test pins
  the deny-all shape so per-tool enumerations cannot creep back.
- **Honest `local-only` privacy contract.** The previous claim "never leave
  the machine" was not enforceable: `memory_read` returned local-only entries
  as tool output (which reaches the provider), and the DREAM dedup prompt
  included them among existing entries. Local-only entries are now excluded
  from EVERY model-visible path: SURFACE injection, DREAM entries and dedup
  prompts, rerank candidates, all tool responses (`memory_read`,
  `memory_why`, `memory_inspect`) and all mutating tools. The documented
  access path is direct human inspection of `OPENCODE_MEMORY_DIR`; remaining
  limitations (the write call itself, prior transcript exposure, summary
  generation by the provider) are documented in the README threat model.

## [1.5.0] — 2026-08-11

### Added

- Time-based decay is now applied exactly once, in `score()`, computed from
  `lastSeen`: previously `prune()` decayed `weight` in place and `score()`
  decayed again, so forgetting depended on how often pruning ran rather than
  on elapsed time. `weight` is now a static importance baseline (never
  mutated); `prune()` only applies the floor to the score.
- Provenance: dreamed memories record `sourceSessionID`, `sourceMessageIDs`,
  `extractedAt` and `confidence`; explicit ones record `createdBy`. New
  `memory_why` tool explains where a memory comes from and why it ranks
  where it does.
- Memory Inspector: `memory_inspect` with `stats`, `recent`, `conflicts`,
  `project` and `surfaced` views, including the "why was this surfaced"
  breakdown (base score, keyword match, core bonus, final rank).
- Contradiction lifecycle: the consolidation reports conflicts against
  `explicit` entries (`conflicts` in DREAM output); entries become
  CONFLICTED instead of being silently overwritten, and `memory_update` /
  `memory_write` resolves them. Replaced dreamed entries become SUPERSEDED
  tombstones (grace-period pruned).
- Memory tiers: `core` (always surfaced), `archival` (on relevance),
  `temporary` (`expiresAt`, auto-removed), `pinned` (never decays). Legacy
  stores migrate their tiers from categories.
- Hybrid retrieval: pure `retrieve()` pipeline (scope filter + expanded
  keyword relevance + time score) with an optional semantic reranking stage
  (`OPENCODE_MEMORY_RERANK=1`) that reranks the candidate window through a
  headless LLM call (per-query cache, timeout fallback to lexical order).
  Surfacing is relevance-gated: off-topic queries surface nothing but the
  core slot.
- Retrieval feedback: `memory_useful` / `memory_irrelevant` update
  `useCount` / `lastUsed` / `helpfulCount` / `irrelevantCount`; the score
  integrates a bounded utilization bonus. Surfaced memories refresh
  `lastSeen` (debounced) so active memories stay alive by exposure.
- Per-memory privacy: `sensitivity` (`normal` | `private` | `local-only`);
  `local-only` facts are never surfaced to providers nor included in
  consolidation prompts.
- Evaluation suite: `bun run bench` — 90 scenarios (paraphrase, IT/EN,
  synonyms, distractors, contradictions, duplicates, project isolation,
  obsolete facts, false positives, none) measuring Recall@5, Precision@5,
  MRR, false-surface rate and context overhead per failure mode.
- Store schema v2 with automatic v1 → v2 migration on read.

### Changed

- DREAM prompt: contradictions are reported (task 4) instead of silently
  ignored; new facts may carry an optional 0–1 `confidence`.
- `memory_write` accepts `tier`, `ttlHours`, `pinned` and `sensitivity`;
  rewriting a CONFLICTED entry resolves it.
- Surfaced CONFLICTED entries are flagged in the memory block so the agent
  can offer to fix them.

## [1.1.0] — 2026-08-06

### Added

- Cross-language semantic deduplication: second-pass LLM check inside the
  headless consolidation session plus code-level guards (`findSimilar`,
  `topicClash`).
- Source hierarchy: `explicit` (user-stated) memories always win over
  `dreamed` (inferred) ones; conflicting facts never enter the summary.
- Selective topic-aware SURFACE: topic keywords extracted from the last user
  message, expanded with bilingual synonyms (EN/IT), permanent core of
  operative categories always included.
- Orphan child-session garbage collection (age + inactivity, cross-process
  exempt via `inProgress` markers).
- Two-phase state commit (`inProgress` marker + `lastCompletedTs`): at-least-
  once consolidation semantics without duplicates, crash recovery included.
- Guard against consolidating a session while the assistant response is still
  streaming (prevents double consolidation).

### Changed

- Unified weight specification: 3 (explicit) / 1 (dreamed) on creation,
  +0.5 per confirmation, cap 4 for all sources.
- Single category list (`user`, `project`, `workflow`, `preferences`,
  `decisions`, `status`, `environment`, `other`); legacy `general` entries are
  migrated to `other` on read.
- Store reads are always fresh from disk (no stale in-memory cache).

### Fixed

- Silent consolidation skip caused by a non-existent `info.time.updated` field
  (real fields: `info.time.completed` / `info.time.created`).
- `waitForReply` reading the first turn's answer on a second LLM turn (now
  filters by timestamp).
- Double consolidation triggered by the sweep while the response was still
  streaming.

## [1.0.0] — 2026-08-05

### Added

- Initial release candidate: WRITE tools, headless DREAM consolidation,
  SURFACE memory injection, local JSON storage with file locking.
