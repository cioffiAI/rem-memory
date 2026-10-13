// Pure logic of rem-memory, kept free of opencode runtime dependencies so
// it can be unit-tested directly. The plugin entrypoint (index.ts) imports
// from here; nothing of this module is re-exported from the entrypoint.

export type Entry = {
  id: string
  text: string
  category: string
  scope: "global" | "project"
  projectID?: string
  weight: number
  created: number
  lastSeen: number
  source: "explicit" | "dreamed"
  // Provenance (v2): where a memory comes from, so every fact is auditable.
  createdBy?: "memory_write" | "memory_update" | "consolidation"
  sourceSessionID?: string
  sourceMessageIDs?: string[]
  extractedAt?: number
  confidence?: number
  // Tier (v2): core is always surfaced, archival only on relevance,
  // temporary expires, pinned never decays. Legacy entries are derived
  // from the category during migration (see normalizeStore).
  tier?: "core" | "archival" | "temporary"
  pinned?: boolean
  expiresAt?: number
  // Lifecycle (v2): explicit memories that the consolidation contradicts
  // are marked CONFLICTED (never silently overwritten); user resolution
  // brings them back to ACTIVE; replaced ones become SUPERSEDED tombstones.
  status?: "ACTIVE" | "CONFLICTED" | "SUPERSEDED"
  conflictEvidence?: string
  conflictAt?: number
  supersededAt?: number
  // Usage feedback (v2): how the memory performed in retrieval.
  useCount?: number
  lastUsed?: number
  helpfulCount?: number
  irrelevantCount?: number
  // Exposure tracking (v1.5.1): automatic surfacing is NOT evidence that a
  // fact is still current, so it must never touch `lastSeen`. Exposure is
  // recorded separately and feeds statistics only (never the score).
  lastSurfaced?: number
  surfacedCount?: number
  // Code anchors (v3): files/symbols this fact is about.
  anchors?: Anchor[]
  // Privacy (v2): local-only facts are stored on disk only; they never reach
  // any model-visible path (see readableEntries / consolidationEntries).
  sensitivity?: "normal" | "private" | "local-only"
}

// Code anchor (v3): ties a project fact to a file (and optionally a symbol).
export type Anchor = { path: string; symbol?: string; hash: string; anchoredAt: number }

// Session handoff (v3): a "where we left off" note for the next session.
export type Handoff = {
  id: string
  projectID: string
  sessionID: string
  origin: { host: "opencode"; agent?: string }
  createdAt: number
  updatedAt: number
  branch?: string
  request?: string
  files: { path: string; status: string }[]
  narrative?: { goal: string; state: string; next: string[]; openQuestions: string[] }
  level: "mechanical" | "enriched"
  dismissedAt?: number
}

export type Store = {
  version: 3
  summary: string
  updatedAt: number
  entries: Entry[]
  handoffs: Handoff[]
}

export const DAY = 24 * 60 * 60 * 1000

// Single source of truth for categories. "other" is the fallback category;
// "general" is NOT a valid category (legacy entries with that value are
// normalized to "other" on read, see normalizeStore).
export const CATEGORIES = ["user", "project", "workflow", "preferences", "decisions", "status", "environment", "other"]

export function emptyStore(): Store {
  return { version: 3, summary: "", updatedAt: 0, entries: [], handoffs: [] }
}

// Legacy stores (version 1 and 2) are migrated in place (to 3, additively): unknown categories fall
// back to "other", and each entry gets its tier, status and sensitivity
// defaults derived from what v1 already encoded.
export function normalizeStore(store: Store): Store {
  const v = (store as { version?: unknown }).version
  if (v !== 1 && v !== 2 && v !== 3) return emptyStore()
  store.version = 3
  if (!Array.isArray(store.handoffs)) store.handoffs = []
  for (const e of store.entries) {
    if (e.category === "general" || !CATEGORIES.includes(e.category)) e.category = "other"
    if (!e.tier) e.tier = CORE_CATEGORIES.has(e.category) ? "core" : "archival"
    if (!e.status) e.status = "ACTIVE"
    if (!e.sensitivity) e.sensitivity = "normal"
  }
  return store
}

// Time-based decay is applied HERE and nowhere else. weight is a static
// importance baseline (raised on refresh, never decayed in place): the score
// of an entry therefore depends only on how much time has passed, never on
// how many times prune() happened to run.
export function score(entry: Entry, t = Date.now()): number {
  if (entry.pinned === true) {
    const sourceBonusPinned = entry.source === "explicit" ? 0.5 : 0
    return entry.weight + sourceBonusPinned + utilizationBonus(entry)
  }
  const days = Math.max(0, (t - entry.lastSeen) / DAY)
  const sourceBonus = entry.source === "explicit" ? 0.5 : 0
  return (entry.weight + sourceBonus + utilizationBonus(entry)) * Math.exp(-days / 45)
}

// Usage feedback modulates the score: memories that proved helpful rank
// higher and are forgotten later; memories marked irrelevant rank lower.
// Both bonuses saturate to keep the scale bounded.
export function utilizationBonus(entry: Entry): number {
  const helpful = Math.min(5, entry.helpfulCount ?? 0) * 0.1
  const irrelevant = Math.min(5, entry.irrelevantCount ?? 0) * 0.15
  return Math.max(-0.5, helpful - irrelevant)
}

export function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Tokenizer for MATCHING (v1.6): identifier boundaries are word boundaries.
// camelCase / PascalCase are split ("userStore" -> "user","store"), snake/
// kebab/dotted/path separators split via normalization. Both the WHOLE
// compound ("javascript") and its parts ("java","script") are emitted, so
// canonical names keep matching while inner terms stay reachable. Matching
// never crosses these boundaries: a keyword cannot match because it occurs
// INSIDE a longer unrelated token.
export function tokens(text: string): string[] {
  const out = new Set<string>()
  const camelRe = /([\p{Ll}])([\p{Lu}])/gu
  for (const rawWord of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!rawWord) continue
    const whole = rawWord.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    if (/\p{L}|\p{N}/u.test(whole)) out.add(whole)
    const split = rawWord.replace(camelRe, "$1 $2").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    for (const part of split.split(/\s+/)) if (part) out.add(part)
  }
  return [...out]
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const set = new Set(tb)
  const overlap = ta.filter((t) => set.has(t)).length
  return overlap / Math.min(ta.length, tb.length)
}

export function findSimilar(entries: Entry[], text: string, threshold = 0.6): Entry | undefined {
  const n = norm(text)
  return entries.find(
    (e) =>
      similarity(e.text, text) >= threshold ||
      (n.length > 3 && n.includes(norm(e.text))) ||
      (norm(e.text).length > 3 && norm(e.text).includes(n)),
  )
}

// Content-word overlap (tokens >= 4 chars), used as a topic-level guard
// against duplicates that plain token similarity misses across languages.
// Stopwords (common EN/IT verbs, pronouns and function words) are excluded
// to avoid false clashes between unrelated facts that merely share words
// like "user" or "like".
const CLASH_STOPWORDS = new Set([
  "user", "users", "like", "likes", "want", "wants", "need", "needs", "use", "uses", "used", "using",
  "write", "writes", "wrote", "work", "works", "worked", "working", "would", "could", "should",
  "this", "that", "these", "those", "with", "from", "have", "has", "they", "them", "their", "your",
  "its", "about", "when", "what", "there", "make", "makes", "get", "gets",
  "utente", "utenti", "vorrebbe", "vuole", "serve", "servono", "usa", "usare", "usato", "usando",
  "scrive", "scrivere", "scritto", "lavora", "lavorare", "lavorando", "questo", "questa",
  "quello", "quella", "con", "per", "della", "degli", "delle", "della", "nella", "nelle", "dei",
  "che", "chi", "come", "cosa", "fare", "fatto", "fare", "dopo", "prima", "solo", "anche",
])
export function topicClash(a: string, b: string): boolean {
  const ta = tokens(a)
    .filter((t) => t.length >= 4)
    .filter((t) => !CLASH_STOPWORDS.has(t))
  const tb = tokens(b)
    .filter((t) => t.length >= 4)
    .filter((t) => !CLASH_STOPWORDS.has(t))
  if (ta.length === 0 || tb.length === 0) return false
  const set = new Set(tb)
  return ta.some((t) => set.has(t))
}

// ---------------------------------------------------------------------------
// Scope & privacy policy (single source of truth)
//
// Every code path that reads, lists, mutates or exposes entries MUST go
// through these predicates instead of re-implementing scope checks:
//
//   projectVisible(e, dir) — a project-scoped entry belongs to exactly one
//     project directory; global entries are visible everywhere.
//   isLocalOnly(e)         — local-only entries live on disk only. They are
//     excluded from every model-visible path: SURFACE injection, DREAM
//     prompts (entries list AND dedup prompt), semantic rerank candidates,
//     summaries-by-construction, tool responses (memory_read/why/inspect),
//     and every mutating tool (update/forget/feedback). The only supported
//     access path is direct file inspection of REM_MEMORY_DIR by the
//     human user.
// ---------------------------------------------------------------------------

export function projectVisible(e: Entry, directory: string | undefined): boolean {
  return e.scope === "global" || (e.scope === "project" && !!directory && e.projectID === directory)
}

export function isLocalOnly(e: Entry): boolean {
  return e.sensitivity === "local-only"
}

// Entries a model-facing tool may return or mutate in this context:
// global + current project, never local-only.
export function readableEntries(store: Store, directory: string | undefined): Entry[] {
  return store.entries.filter((e) => projectVisible(e, directory) && !isLocalOnly(e))
}

// Entries the DREAM pipeline may use (prompt entriesBlock, dedup targets,
// update/delete/conflict resolution): same visibility as tools, because the
// consolidation session is an untrusted child that must not see or modify
// anything outside its own project either.
export function consolidationEntries(store: Store, directory: string | undefined): Entry[] {
  return readableEntries(store, directory)
}

// Exact-text refresh target for memory_write: restricted to the SAME scope (and
// same project for scope=project). A global fact and an equivalent project
// fact may coexist by design; neither suppresses the other. Normal writes
// never target local-only entries (they are invisible); a write that is
// ITSELF local-only may refresh a previous local-only entry so repeated
// writes do not accumulate duplicates.
export function findWritableTarget(
  entries: Entry[],
  text: string,
  scope: Entry["scope"],
  directory: string | undefined,
  includeLocalOnly = false,
): Entry | undefined {
  const candidates = entries.filter(
    (e) =>
      (includeLocalOnly || !isLocalOnly(e)) &&
      e.scope === scope &&
      (scope === "global" || e.projectID === directory),
  )
  // Similar wording can describe distinct facts. Only refresh exact text;
  // preserve punctuation so technical identifiers such as C++ and C# differ.
  const canonical = (value: string) => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()
  return candidates.find((entry) => canonical(entry.text) === canonical(text))
}

// ---------------------------------------------------------------------------
// memory_read query grammar (issue #4). Legacy contiguous substring semantics
// are KEPT as the first path (a query like "coff" still matches "coffee", and
// category substrings still match); a second path requires EVERY query word to
// be satisfied by the entry text or category, in any order and non-contiguous.
// This makes "coffee morning" match "coffee in the morning" without the issue
// patch's regressions: short terms are never dropped ("AI", "UI", "DB", "C",
// "R", "no" stay meaningful) and token boundaries are respected, so "AI
// models" does not match "statistical models".
//
// Identifier symmetry: a query word is one group of alternative spellings —
// its compact form AND its case-boundary parts. A camelCase word matches when
// the entry has the compact form OR all of its parts, so every direction works:
// "JavaScript" matches "javascript is my preferred language." (compact),
// "javascript" matches "JavaScript is ..." (parts), and "userStore" matches
// "user store" (parts) — while "java" alone never satisfies "JavaScript".
// Query and entry are tokenized through the SAME word grammar, so casing of
// the query (lower/upper/mixed) can no longer change the outcome.
//
// Deliberately NOT reused here: tokens() folds accents and strips identifier
// punctuation (C++ -> "c"), and topicKeywords() drops terms <= 2 chars. This
// grammar keeps technical identifiers distinct (C++ vs C#, Node.js, .NET),
// does not fold accents ("caffe" must not match "caffè"), and treats hyphens
// and underscores as separators (AI-powered -> AI + powered). It is lexical
// only: no stemming, synonyms, semantic search or query operators.
// ---------------------------------------------------------------------------

// One query word and the spellings that satisfy it. `whole` is the compact
// lowercased form; `parts` are its case-boundary parts. For a word without a
// case boundary the two coincide.
export type QueryTermGroup = {
  whole: string
  parts: string[]
}

function wordForms(raw: string): QueryTermGroup | undefined {
  // Trailing sentence punctuation ("coffee." / "morning.") is not part of
  // the word; edge dots are never meaningful (".NET." -> "net"). The symbols
  // that distinguish identifiers (+, #, inner dots) are preserved instead.
  const clean = raw.replace(/^\.+|\.+$/g, "")
  if (!clean) return undefined
  // Same case-boundary rule as tokens(): split at lower→upper transitions
  // ("userStore" -> user + store).
  const parts = clean
    .replace(/([\p{Ll}])([\p{Lu}])/gu, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return { whole: clean.toLowerCase(), parts }
}

export function queryTermGroups(query: string): QueryTermGroup[] {
  const groups: QueryTermGroup[] = []
  const seen = new Set<string>()
  for (const raw of query.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? []) {
    const group = wordForms(raw)
    if (!group || seen.has(group.whole)) continue
    seen.add(group.whole)
    groups.push(group)
  }
  return groups
}

// Vocabulary a text exposes to the token-AND path: every word as its compact
// form AND its case-boundary parts, so an identifier can be found through
// either spelling.
function entryVocabulary(text: string): Set<string> {
  const vocabulary = new Set<string>()
  for (const raw of text.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? []) {
    const group = wordForms(raw)
    if (!group) continue
    vocabulary.add(group.whole)
    for (const part of group.parts) vocabulary.add(part)
  }
  return vocabulary
}

function groupMatches(group: QueryTermGroup, vocabulary: Set<string>): boolean {
  // Compact form first; otherwise ALL parts of the identifier must be
  // present, so one half never satisfies a camelCase word by itself.
  return vocabulary.has(group.whole) || group.parts.every((part) => vocabulary.has(part))
}

// Path 1 preserves the historical substring semantics exactly; path 2 is the
// token-boundary AND described above. An empty group list (punctuation-only
// query) disables path 2 so it can never collapse into "match everything".
function matchesQuery(e: Entry, q: string, groups: QueryTermGroup[]): boolean {
  if (e.text.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)) return true
  if (groups.length === 0) return false
  const vocabulary = entryVocabulary(`${e.text} ${e.category}`)
  return groups.every((group) => groupMatches(group, vocabulary))
}

// memory_read policy: filter + search within the readable set only.
export function readQuery(
  store: Store,
  directory: string | undefined,
  opts: { query?: string; category?: string; scope?: "global" | "project" } = {},
): Entry[] {
  // The raw (case-preserving) query feeds the identifier grammar; only the
  // legacy substring path uses the lowercased form.
  const raw = String(opts.query ?? "").trim()
  const q = raw.toLowerCase()
  const groups = raw ? queryTermGroups(raw) : []
  return readableEntries(store, directory)
    .filter((e) => !q || matchesQuery(e, q, groups))
    .filter((e) => !opts.category || e.category === opts.category)
    .filter((e) => !opts.scope || e.scope === opts.scope)
    .sort((a, b) => score(b) - score(a))
}

// memory_clear(scope="project") removes ONLY the current project's entries —
// never another project's project-scoped memories. Returns the removed count.
export function clearProjectEntries(store: Store, directory: string | undefined): number {
  const before = store.entries.length
  store.entries = store.entries.filter((e) => !(e.scope === "project" && !!directory && e.projectID === directory))
  return before - store.entries.length
}

// Automatic exposure bookkeeping. Updates ONLY exposure/usage counters, at
// most once per entry per minIntervalMs. It deliberately does NOT touch
// `lastSeen`: being surfaced is not evidence that a fact is still true, and
// letting it refresh recency would create a self-reinforcing loop where
// frequently ranked memories stay artificially fresh (and immortal under
// prune()). Explicit positive feedback (applyUsefulFeedback) IS treated as
// confirmation because the user affirms the fact through their agent.
export function applySurfaceFeedback(store: Store, ids: string[], t = Date.now(), minIntervalMs = 0): void {
  for (const id of ids) {
    const e = store.entries.find((x) => x.id === id)
    if (!e) continue
    if (minIntervalMs > 0 && t - (e.lastUsed ?? 0) < minIntervalMs) continue
    e.lastSurfaced = t
    e.surfacedCount = (e.surfacedCount ?? 0) + 1
    e.useCount = (e.useCount ?? 0) + 1
    e.lastUsed = t
  }
}

// Explicit positive feedback: counts as confirmation (refreshes lastSeen).
export function applyUsefulFeedback(store: Store, id: string, t = Date.now()): boolean {
  const e = store.entries.find((x) => x.id === id)
  if (!e) return false
  e.helpfulCount = (e.helpfulCount ?? 0) + 1
  e.useCount = (e.useCount ?? 0) + 1
  e.lastUsed = t
  e.lastSeen = t
  return true
}

// Negative feedback lowers ranking but says nothing about factual currency.
export function applyIrrelevantFeedback(store: Store, id: string, t = Date.now()): boolean {
  const e = store.entries.find((x) => x.id === id)
  if (!e) return false
  e.irrelevantCount = (e.irrelevantCount ?? 0) + 1
  e.useCount = (e.useCount ?? 0) + 1
  e.lastUsed = t
  return true
}

// ---------------------------------------------------------------------------
// Structured-answer parsing for headless helper sessions (rerank/dedup).
// Pure so it stays directly unit-testable.
// ---------------------------------------------------------------------------

export function extractJson(text: string): any | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object") return parsed
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  const arrStart = trimmed.indexOf("[")
  const arrEnd = trimmed.lastIndexOf("]")
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1))
    } catch {
      /* fall through */
    }
  }
  return undefined
}

export type RerankOutcome =
  | { kind: "order"; order: number[] }
  | { kind: "abstain" }
  | { kind: "invalid" }

// Parse a reranker answer. An explicit empty {"order":[]} means the model
// found NO relevant candidate (abstain): ranking a window is not evidence
// that anything in it answers the question. Unparseable output is "invalid"
// and must fall back to the deterministic lexical order.
export function parseRerankAnswer(text: string, candidateCount: number): RerankOutcome {
  const parsed = extractJson(text)
  if (!parsed || !Array.isArray(parsed.order)) return { kind: "invalid" }
  if (parsed.order.length === 0) return { kind: "abstain" }
  const order = parsed.order
    .map(Number)
    .filter((i: number) => Number.isInteger(i) && i >= 0 && i < candidateCount)
  return { kind: "order", order }
}

export function applyRerankOrderAnswer(candidates: RankedMemory[], outcome: RerankOutcome): RankedMemory[] {
  if (outcome.kind === "abstain") return []
  if (outcome.kind === "invalid") return candidates
  const pos = new Map(outcome.order.map((i, rank) => [candidates[i]?.entry.id, rank]))
  return [...candidates].sort((a, b) => {
    const pa = pos.get(a.entry.id)
    const pb = pos.get(b.entry.id)
    if (pa === undefined && pb === undefined) return b.base - a.base
    if (pa === undefined) return 1
    if (pb === undefined) return -1
    return pa - pb
  })
}

export function addEntry(store: Store, e: Omit<Entry, "id" | "created"> & { created?: number }) {
  store.entries.push({
    ...e,
    id: crypto.randomUUID(),
    created: e.created ?? Date.now(),
  })
}

export function prune(store: Store, t = Date.now(), maxEntries = 400) {
  // Never mutate weight here: decay is applied exclusively in score().
  // Entries below the floor are removed (their score is a function of time
  // alone, so removal is deterministic regardless of prune frequency).
  // SUPERSEDED tombstones are dropped after a short grace period so the
  // "forgot" history stays queryable for a while without accumulating.
  store.entries = store.entries.filter((e) => {
    if (e.status === "SUPERSEDED") {
      const supersededAt = e.supersededAt ?? e.lastSeen
      return t - supersededAt < 30 * DAY
    }
    if (e.expiresAt !== undefined && e.expiresAt <= t) return false
    return score(e, t) >= 0.15
  })
  store.entries.sort((a, b) => score(b, t) - score(a, t))
  store.entries = store.entries.slice(0, maxEntries)
}

export type LogLevel = "debug" | "info" | "warn" | "error"

// Anchors reaching applyConsolidation were already resolved against the
// filesystem by the DREAM step; here we only keep well-formed ones.
function sanitizeAnchors(value: unknown): Anchor[] {
  if (!Array.isArray(value)) return []
  const anchors: Anchor[] = []
  for (const item of value) {
    if (!item || typeof item.path !== "string" || typeof item.hash !== "string" || typeof item.anchoredAt !== "number") continue
    anchors.push({
      path: item.path,
      ...(typeof item.symbol === "string" && item.symbol ? { symbol: item.symbol } : {}),
      hash: item.hash,
      anchoredAt: item.anchoredAt,
    })
  }
  return anchors.slice(0, 3)
}

export type ConsolidationSource = {
  sessionID?: string
  messageIDs?: string[]
}

export function applyConsolidation(
  store: Store,
  parsed: {
    new?: any[]
    update?: any[]
    delete?: string[]
    summary?: string
    conflicts?: { id?: string; evidence?: string }[]
  },
  projectID: string | undefined,
  t = Date.now(),
  log?: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void,
  source?: ConsolidationSource,
) {
  // Trust boundary: the consolidation model only ever saw entries visible in
  // ITS project context (global + own project, never local-only — see
  // consolidationEntries()). Every lookup below is therefore restricted to
  // that same set, so output referring to other projects' or local-only ids
  // (hallucinated or hostile) cannot suppress, merge with, replace,
  // supersede or flag them.
  const visible = () => store.entries.filter((e) => projectVisible(e, projectID) && !isLocalOnly(e))
  for (const item of parsed.new ?? []) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue
    const text = item.text.trim()
    const scope: Entry["scope"] = item.scope === "project" ? "project" : "global"
    const category = typeof item.category === "string" && CATEGORIES.includes(item.category) ? item.category : "other"
    const existing = findSimilar(visible(), text, 0.5)
    const confidence =
      typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : undefined
    if (existing) {
      // Source hierarchy: explicit (user-stated) always wins. Never
      // duplicate or rewrite it from an inference.
      if (existing.source === "explicit") {
        log?.("debug", "dedup skipped (explicit wins)", { text, existingId: existing.id })
        continue
      }
      existing.text = text
      existing.weight = Math.min(4, existing.weight + 0.5)
      existing.lastSeen = t
      existing.createdBy = "consolidation"
      existing.sourceSessionID = source?.sessionID ?? existing.sourceSessionID
      existing.extractedAt = t
      if (confidence !== undefined) existing.confidence = confidence
      if (scope === "project" && !existing.projectID) existing.projectID = projectID
      const anchors = existing.scope === "project" ? sanitizeAnchors(item.anchors) : []
      if (anchors.length > 0) existing.anchors = anchors
    } else {
      // Topic-level guard: same category + shared content word → treat as
      // duplicate of an explicit fact even across languages. Restricted to
      // the consolidation-visible set (own project + global).
      const clash = visible().find(
        (e) => e.source === "explicit" && e.category === category && topicClash(e.text, text),
      )
      if (clash) {
        log?.("debug", "dedup skipped (topic clash with explicit)", { text, existingId: clash.id })
        continue
      }
      const anchors = scope === "project" ? sanitizeAnchors(item.anchors) : []
      addEntry(store, {
        text,
        category,
        scope,
        projectID: scope === "project" ? projectID : undefined,
        ...(anchors.length > 0 ? { anchors } : {}),
        weight: 1,
        lastSeen: t,
        source: "dreamed",
        created: t,
        createdBy: "consolidation",
        sourceSessionID: source?.sessionID,
        sourceMessageIDs: source?.messageIDs,
        extractedAt: t,
        confidence,
      })
    }
  }
  for (const item of parsed.update ?? []) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue
    const target = item.id
      ? visible().find((e) => e.id === item.id)
      : item.match
        ? findSimilar(visible(), String(item.match))
        : undefined
    // Inferences never rewrite explicit facts: only memory_update/forget do.
    if (target && target.source !== "explicit") {
      target.text = item.text.trim()
      target.weight = Math.min(4, target.weight + 0.5)
      target.lastSeen = t
      target.extractedAt = t
      target.sourceSessionID = source?.sessionID ?? target.sourceSessionID
      const anchors = target.scope === "project" ? sanitizeAnchors(item.anchors) : []
      if (anchors.length > 0) target.anchors = anchors
    }
  }
  for (const item of parsed.delete ?? []) {
    if (typeof item !== "string") continue
    const del = item.trim()
    const target = visible().find((e) => e.id === del)
    if (target && target.source !== "explicit") {
      // Dreamed entries are never hard-deleted by consolidation: they become
      // SUPERSEDED tombstones (auditable, pruned after the grace period).
      target.status = "SUPERSEDED"
      target.supersededAt = t
    } else {
      const deletable = new Set(visible().filter((e) => e.source !== "explicit").map((e) => e.id))
      store.entries = store.entries.filter(
        (e) =>
          !deletable.has(e.id) ||
          (e.id !== del && !(del.length > 3 && e.text.toLowerCase().includes(del.toLowerCase()))),
      )
    }
  }
  // Contradiction reporting: an explicit entry the conversation conflicts
  // with is flagged, never silently overwritten. The user (or the agent on
  // their behalf) resolves it via memory_update / memory_write.
  for (const c of parsed.conflicts ?? []) {
    if (!c || typeof c.id !== "string") continue
    const target = visible().find((e) => e.id === c.id)
    if (!target) continue
    const evidence = typeof c.evidence === "string" ? c.evidence.slice(0, 500) : ""
    target.status = "CONFLICTED"
    target.conflictEvidence = evidence || "contradicted in a later conversation"
    target.conflictAt = t
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    store.summary = parsed.summary.trim().slice(0, 3000)
  }
  store.updatedAt = t
}

const STOPWORDS = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
  "che", "e", "o", "ma", "se", "come", "quando", "cosa", "chi", "dove", "perche", "anche", "non", "piu", "mi", "ti",
  "si", "ci", "vi", "the", "an", "and", "or", "but", "of", "to", "in", "for", "with", "on", "at", "by", "is", "are",
  "was", "were", "be", "do", "does", "did", "what", "who", "how", "why", "when", "where", "i", "you", "he", "she",
  "it", "we", "they", "my", "your", "our", "their", "this", "that", "please", "ciao", "hello", "hi", "ok", "grazie",
  "thanks", "can", "could", "would", "should", "will", "want", "need", "vorrei", "puoi", "potresti", "mio", "mia",
  "miei", "mie", "tuo", "tua", "tuoi", "tue", "suo", "sua", "sono", "era", "ero", "voglio", "posso", "fai", "fare",
  "fammi", "dimmi", "sai", "so", "parliamo", "abbiamo", "avrei", "sarebbe", "della", "dello", "delle", "degli",
  "alla", "allo", "alle", "agli", "nel", "nella", "nello", "nelle", "negli", "dal", "dalla", "dallo", "dalle",
  "dagli", "sul", "sulla", "sullo", "sulle", "sugli", "perche'", "come", "molto", "troppo", "qualcosa", "cosa",
  "posso", "ti", "vi", "ci", "lo", "la", "le", "li", "ne", "egli", "ella", "essi", "esse", "questo", "questa",
  "quello", "quella", "quelli", "quelle", "sto", "sta", "stai", "state", "siamo", "essere", "avere", "fare", "dire",
  "andare", "venire", "prendere", "vedere", "volere", "potere", "dovere", "sapere", "mettere", "lasciare", "trovare",
  "uscire", "entrare", "i", "you", "we", "they", "he", "she", "it", "me", "us", "them", "him", "her", "my", "your",
  "our", "their", "this", "that", "these", "those", "please", "hello", "hi", "ok", "thanks", "thank", "there",
  "their", "about", "into", "onto", "over", "under", "between", "from", "after", "before", "during", "against",
  "which",
  // Generic subject words: nearly every stored fact begins with "The user
  // ..." / "L'utente ...", so treating them as topic keywords made ANY query
  // mentioning them match EVERY entry, silently defeating the relevance gate
  // (found by the v1.5.1 falsifiable benchmark).
  "user", "users", "utente", "utenti",
  // NOTE (v1.6): opinion/preference verbs (like/prefer/ama/piacere...) are
  // deliberately NOT stopwords and NOT synonym-group members: as direct
  // keywords their inflections bridge morphological variants
  // (prefer -> prefers), while removing them from the synonym groups killed
  // the unsafe cross-domain expansion ("color" -> "favorite").
])

// Permanent core: operative preferences always surfaced regardless of topic.
export const CORE_CATEGORIES = new Set(["preferences", "workflow", "decisions", "environment"])

export function topicKeywords(text: string): string[] {
  return tokens(text).filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

// Bilingual synonym groups bridge the gap between semantic dedup (LLM) and
// lexical retrieval without embeddings. v1.6 policy: a group contains ONLY
// terms that are substitutable for retrieval relevance — translations,
// morphological variants, abbreviations or aliases of the SAME concept.
// Related-but-not-interchangeable concepts (design vs project) and opinion
// verbs (see STOPWORDS) do NOT belong here: expanding them made queries about
// one domain surface memories from another.
//
// NOTE on lookup semantics: expansion stops at the FIRST group containing a
// keyword (see expandTopicKeywordsDetailed). Groups sharing a head term on
// purpose keep different expansions narrow — e.g. "database" expands to its
// aliases {databases, db} but NOT to the broader data-family {data, dataset,
// dati}, which is reachable only from "dataset"-family queries.
const SYNONYM_GROUPS: string[][] = [
  ["language", "languages", "linguaggio", "linguaggi", "code", "codice", "coding", "programmazione", "programming"],
  ["system", "systems", "sistema", "sistemi", "platform", "piattaforma"],
  ["color", "colors", "colore", "colori"],
  ["database", "databases", "db"],
  ["plugin", "plugins", "estensione", "estensioni", "extension", "extensions", "addon", "addons"],
  ["app", "apps", "application", "applications", "applicazione", "applicazioni"],
  ["web", "website", "websites", "sito", "siti", "pagina", "pagine"],
  ["test", "tests", "testing", "testare", "verifica", "verifiche", "verificare"],
  ["bug", "bugs", "error", "errors", "errore", "errori", "issue", "issues"],
  ["os", "operating"],
  ["memory", "memoria", "remember", "ricordare", "ricordi", "ricorda"],
  ["work", "works", "job", "jobs", "lavoro", "lavorare", "lavora", "lavori", "career", "carriera"],
  ["server", "servers", "hosting"],
  ["network", "networks", "rete", "reti", "networking"],
  ["security", "sicurezza", "secure", "sicuro", "privacy"],
  ["design", "designer", "progettazione", "progettare"],
  ["project", "projects", "progetto", "progetti"],
  ["database", "data", "dataset", "dati"],
]

// Expand topic keywords with all forms of their bilingual synonym group.
// The detailed variant records PROVENANCE: which query token produced each
// expanded term (undefined = the term is a query token itself). Retrieval
// explanations need this to attribute every match to its origin.
export type ExpandedKeyword = {
  term: string
  /** original query topic keyword; undefined when term IS a query keyword */
  via?: string
}

export function expandTopicKeywordsDetailed(keywords: string[]): ExpandedKeyword[] {
  const out = new Map<string, string | undefined>()
  for (const k of keywords) out.set(k, undefined)
  for (const k of keywords) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(k)) {
        for (const form of group) if (!out.has(form)) out.set(form, k)
        break
      }
    }
  }
  return [...out.entries()].map(([term, via]) => (via === undefined ? { term } : { term, via }))
}

export function expandTopicKeywords(keywords: string[]): string[] {
  return expandTopicKeywordsDetailed(keywords).map((x) => x.term)
}

// ---------------------------------------------------------------------------
// Retrieval pipeline
// ---------------------------------------------------------------------------

export const KEYWORD_BONUS = 3

export type RankedMemory = {
  entry: Entry
  // base: pure time/weight score, before any relevance bonus.
  base: number
  // keywordHits: how many expanded topic keywords matched the memory text.
  keywordHits: number
  // Per-keyword match provenance (v1.6): WHAT matched and HOW. This makes
  // every surfacing decision auditable — see KeywordMatch / MatchKind.
  matches: KeywordMatch[]
  // core: the memory was selected through its core tier slot, not relevance.
  core: boolean
  // rank: 1-based final position within the candidate window.
  rank: number
  // final: total ordering score (base + keyword bonus).
  final: number
}

// How an expanded keyword matched an entry. v1.6 policy: matches respect
// token boundaries. "exact" = whole-token equality; "inflection" = a small,
// explicit morphological variant (plural s/es/ies, gerund -ing, participle
// -ed) in either direction; "category" = the keyword equals the entry's
// category. Bare substring and open-ended prefix matching were REMOVED:
// they made 'use' match 'user', 'test' match 'pytest'/'greatest' and 'red'
// match 'redesign'. Legacy kinds are kept in the type so v1.5.1 evidence
// files remain readable.
export type MatchKind = "exact" | "prefix" | "substring" | "category" | "inflection"

export type KeywordMatch = {
  /** expanded keyword that matched */
  keyword: string
  kind: MatchKind
  /** true when the keyword is itself a query topic keyword */
  direct: boolean
  /** query keyword that produced this term via synonym expansion */
  via?: string
}

// Explicit morphological variants accepted by the matcher, in BOTH
// directions (entry form of a query term, query form of an entry token).
function inflectedForms(word: string): string[] {
  const out = [`${word}s`, `${word}es`]
  if (word.length >= 4) out.push(`${word}ing`, `${word}ed`)
  if (word.length >= 4 && word.endsWith("y")) out.push(`${word.slice(0, -1)}ies`)
  if (word.length >= 5 && word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`)
  return out
}

// Classify one expanded keyword against an entry under the v1.6
// token-boundary policy. Returns undefined when there is no boundary-safe
// match. Pure and side-effect free.
export function classifyMatch(
  _entryTextNorm: string,
  entryTokens: string[],
  category: string,
  xk: ExpandedKeyword,
): MatchKind | undefined {
  if (entryTokens.includes(xk.term)) return "exact"
  const forms = inflectedForms(xk.term)
  if (entryTokens.some((t) => forms.includes(t))) return "inflection"
  // reverse direction: the KEYWORD is an inflected form of an entry token
  if (
    entryTokens.some((t) => {
      if (t.length < 3) return false
      return inflectedForms(t).includes(xk.term)
    })
  )
    return "inflection"
  if (category === xk.term) return "category"
  return undefined
}

export type RetrieveOptions = {
  // Excluded sensitivity levels: entries with these values are never
  // returned. SURFACE passes {"local-only"}; model-facing tools exclude
  // local-only unconditionally via readableEntries()/readQuery().
  excludeSensitivity?: Set<Entry["sensitivity"]>
  // Candidate window handed to the (optional) semantic reranker.
  candidateCount?: number
}

// Lexical stage of the hybrid pipeline: scope filter + expanded-keyword
// relevance + time/weight score. Returns the top candidate window, sorted,
// each item carrying the breakdown needed to explain WHY it ranked there.
export function retrieve(
  store: Store,
  directory: string | undefined,
  query: string,
  t = Date.now(),
  opts: RetrieveOptions = {},
): RankedMemory[] {
  const window = opts.candidateCount ?? 30
  const expanded = expandTopicKeywordsDetailed(topicKeywords(query))
  const candidates = store.entries.filter(
    (e) =>
      e.status !== "SUPERSEDED" &&
      (e.expiresAt === undefined || e.expiresAt > t) &&
      (e.scope === "global" || (e.scope === "project" && e.projectID === directory)) &&
      !(opts.excludeSensitivity && e.sensitivity && opts.excludeSensitivity.has(e.sensitivity)),
  )
  const ranked = candidates.map((e) => {
    const etTokens = tokens(e.text)
    const matches: KeywordMatch[] = []
    for (const xk of expanded) {
      const kind = classifyMatch("", etTokens, e.category, xk)
      if (kind) {
        matches.push(xk.via === undefined ? { keyword: xk.term, kind, direct: true } : { keyword: xk.term, kind, direct: false, via: xk.via })
      }
    }
    const base = score(e, t)
    return { entry: e, base, keywordHits: matches.length, matches, core: false, rank: 0, final: base + matches.length * KEYWORD_BONUS }
  })
  ranked.sort((a, b) => b.final - a.final)
  const top = ranked.slice(0, window)
  top.forEach((r, i) => (r.rank = i + 1))
  return top
}

// ---------------------------------------------------------------------------
// SURFACE relevance gate (v1.6): candidate generation and surfacing are
// DIFFERENT decisions. retrieve() returns high-recall candidates ranked by
// score; the gate decides what is relevant enough to inject. Lexical policy:
// at least one boundary-safe keyword match. It is deliberately conservative
// and deterministic; semantic judgment belongs to the optional reranker.
// ---------------------------------------------------------------------------
export function passesRelevanceGate(r: Pick<RankedMemory, "matches">): boolean {
  return r.matches.length > 0
}

// Core-slot selection: core-tier memories that did NOT rank via relevance
// are injected anyway (operative preferences always available), newest first,
// up to maxCore. CONFLICTED entries are kept visible so they can be resolved.
export function coreSlot(store: Store, directory: string | undefined, exclude: Set<string>, t = Date.now(), maxCore = 3): Entry[] {
  return store.entries
    .filter(
      (e) =>
        e.status !== "SUPERSEDED" &&
        e.tier === "core" &&
        (e.expiresAt === undefined || e.expiresAt > t) &&
        (e.scope === "global" || (e.scope === "project" && e.projectID === directory)) &&
        e.sensitivity !== "local-only" &&
        !exclude.has(e.id),
    )
    .sort((a, b) => score(b, t) - score(a, t))
    .slice(0, maxCore)
}
