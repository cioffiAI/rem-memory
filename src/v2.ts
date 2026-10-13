import type { Plugin } from "@opencode/plugin"
import {
  addEntry,
  applyConsolidation,
  applyIrrelevantFeedback,
  applyRerankOrderAnswer,
  applySurfaceFeedback,
  applyUsefulFeedback,
  clearProjectEntries,
  consolidationEntries,
  coreSlot,
  DAY,
  extractJson,
  findSimilar,
  findWritableTarget,
  KEYWORD_BONUS,
  parseRerankAnswer,
  passesRelevanceGate,
  prune,
  readQuery,
  readableEntries,
  retrieve,
  score,
  type Entry,
  type RankedMemory,
} from "./core.ts"
import { isDirExplicit, resolveConfig, type MemoryConfig } from "./config.ts"
import { createStore, migrateLegacyStore, type StoreIO } from "./store.ts"

type LogLevel = "debug" | "info" | "warn" | "error"
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
type ToolArgs = Record<string, unknown>
type JsonSchema = Record<string, unknown>

type MemoryTool = {
  name: string
  description: string
  input: JsonSchema
  execute: (args: ToolArgs, context: { sessionID: string }) => Promise<string>
}

type RerankCacheEntry = { at: number; order: string[]; abstain?: boolean }

const MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "memory_update",
  "memory_why",
  "memory_inspect",
  "memory_useful",
  "memory_irrelevant",
  "memory_forget",
  "memory_clear",
] as const

function now() {
  return Date.now()
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function messageText(message: SessionMessage): string {
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") return message.text
  if (message.type === "assistant") {
    return message.content
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n")
  }
  if (message.type === "compaction") return "summary" in message ? String(message.summary) : "[compaction]"
  return `[${message.type}]`
}

function messageTimestamp(message: SessionMessage): number {
  const time = message.time as { created?: number; completed?: number }
  return Math.max(time.created ?? 0, time.completed ?? 0)
}

class V2MemoryRuntime {
  private readonly queue: string[] = []
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSurface = new Map<string, RankedMemory[]>()
  private readonly rerankCache = new Map<string, RerankCacheEntry>()
  private processing = false
  private pumpTask?: Promise<void>
  private readonly controller = new AbortController()
  private eventTask?: Promise<void>
  private sweepStartTimer?: ReturnType<typeof setTimeout>
  private sweepRepeatTimer?: ReturnType<typeof setInterval>
  private readonly registrations: Array<{ dispose: () => Promise<void> }> = []

  private readonly config: MemoryConfig
  private readonly store: StoreIO
  private readonly dirExplicit: boolean

  constructor(private readonly ctx: Plugin.Context) {
    this.config = resolveConfig(ctx.options)
    this.dirExplicit = isDirExplicit(ctx.options)
    this.store = createStore(this.config.dir)
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (level === "debug" && !this.config.debug) return
    const details = extra ? ` ${JSON.stringify(extra)}` : ""
    const line = `[rem-memory] ${message}${details}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else if (level === "debug") console.debug(line)
    else console.info(line)
  }

  async setup(): Promise<() => Promise<void>> {
    if (this.config.off) {
      this.log("info", "memory disabled via configuration")
      return async () => {}
    }

    if (!this.dirExplicit) {
      try {
        if (await migrateLegacyStore(this.config.dir)) this.log("info", "migrated legacy store to rem-memory directory", { dir: this.config.dir })
      } catch (error) {
        this.log("warn", "legacy store migration failed", { error: String(error) })
      }
    }

    const loaded = await this.store.getStore()
    this.log("info", `memory V2 plugin loaded (${loaded.entries.length} entries, summary ${loaded.summary.length} chars)`)

    try {
      await this.registerTools()
      const registered = new Set((await this.ctx.tool.list()).map((tool) => tool.id))
      const missing = MEMORY_TOOL_NAMES.filter((name) => !registered.has(name))
      if (missing.length > 0) throw new Error(`memory V2 tool registration incomplete: ${missing.join(", ")}`)
      this.log("info", `memory V2 tools registered (${MEMORY_TOOL_NAMES.length})`)
      if (this.config.surface) {
        this.registrations.push(await this.ctx.session.hook("context", async (event) => {
          try {
            const block = await this.buildMemoryBlock(String(event.sessionID))
            if (block) event.system.push({ type: "text", text: block })
          } catch (error) {
            this.log("debug", "context hook failed", { error: String(error) })
          }
        }))
      }

      if (this.config.dream) {
        this.eventTask = this.consumeEvents()
        this.sweepStartTimer = setTimeout(() => void this.sweep(), this.config.sweepStartMs)
        this.sweepRepeatTimer = setInterval(() => void this.sweep(), this.config.sweepIntervalMs)
      }

      return () => this.dispose()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private async dispose() {
    this.controller.abort()
    if (this.sweepStartTimer) clearTimeout(this.sweepStartTimer)
    if (this.sweepRepeatTimer) clearInterval(this.sweepRepeatTimer)
    for (const timer of this.debounces.values()) clearTimeout(timer)
    this.debounces.clear()
    this.queue.length = 0
    await this.eventTask?.catch(() => {})
    await this.pumpTask?.catch(() => {})
    for (const registration of this.registrations.splice(0).reverse()) {
      await registration.dispose().catch((error) => {
        this.log("warn", "registration cleanup failed", { error: String(error) })
      })
    }
  }

  private async consumeEvents() {
    try {
      for await (const event of this.ctx.event.subscribe({ signal: this.controller.signal })) {
        // V2 emits durable execution events (without a location); session.idle
        // remains a compatibility event and is not emitted by the native loop.
        if (event.type !== "session.idle" &&
            event.type !== "session.execution.succeeded" &&
            event.type !== "session.execution.failed" &&
            event.type !== "session.execution.interrupted") continue
        const sessionID = String(event.data.sessionID)
        const directory = event.location?.directory ?? (await this.sessionInfo(sessionID))?.location.directory
        if (directory !== this.ctx.location.directory || this.controller.signal.aborted) continue
        this.log("debug", "session completed -> schedule", { sessionID, event: event.type })
        this.scheduleConsolidation(sessionID)
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.log("warn", "event subscription failed", { error: String(error) })
    }
  }

  private scheduleConsolidation(sessionID: string) {
    const existing = this.debounces.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounces.delete(sessionID)
      if (!this.queue.includes(sessionID)) this.queue.push(sessionID)
      void this.startPump()
    }, this.config.delayMs)
    this.debounces.set(sessionID, timer)
  }

  private enqueue(sessionID: string) {
    if (!this.queue.includes(sessionID)) this.queue.push(sessionID)
    void this.startPump()
  }

  private startPump() {
    if (!this.pumpTask) {
      this.pumpTask = this.pump().finally(() => {
        this.pumpTask = undefined
        if (this.queue.length > 0 && !this.controller.signal.aborted) void this.startPump()
      })
    }
    return this.pumpTask
  }

  // The public V2 plugin session domain intentionally does not expose list().
  // Recovery therefore uses the durable inProgress journal: every DREAM that
  // began but did not commit leaves its session ID here. No helper-session GC
  // is needed because generate.text creates no sessions.
  private async sweep() {
    if (this.controller.signal.aborted) return
    try {
      const state = await this.store.getState()
      const candidates = Object.entries(state.inProgress ?? {})
        .filter(([, marker]) => now() - marker.startedAt >= this.config.inProgressTimeoutMs)
        .filter(([sessionID, marker]) => (state.sessions[sessionID] ?? 0) < marker.targetTs)
        .sort(([, left], [, right]) => right.targetTs - left.targetTs)
        .slice(0, this.config.sweepBatch)
      for (const [sessionID] of candidates) this.enqueue(sessionID)
      if (candidates.length > 0) this.log("debug", "recovery sweep queued", { count: candidates.length })
    } catch (error) {
      this.log("warn", "recovery sweep failed", { error: String(error) })
    }
  }

  private async pump() {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const sessionID = this.queue.shift()!
        try {
          await this.consolidate(sessionID)
        } catch (error) {
          this.log("warn", "consolidation failed", { sessionID, error: String(error) })
        }
      }
    } finally {
      this.processing = false
    }
  }

  private async sessionInfo(sessionID: string): Promise<SessionInfo | undefined> {
    try {
      return await this.ctx.session.get({ sessionID })
    } catch (error) {
      this.log("debug", "session.get failed", { sessionID, error: String(error) })
      return undefined
    }
  }

  private async directoryFor(sessionID: string): Promise<string | undefined> {
    const session = await this.sessionInfo(sessionID)
    return session?.location.directory ?? this.ctx.location.directory
  }

  // V2's top-level generate API is intentionally used for all internal model
  // work. Its documented contract creates no session, invokes no tools and
  // writes no history, so DREAM/rerank cannot gain filesystem or network
  // capabilities and leave no helper sessions to delete.
  private async generate(prompt: string, session?: SessionInfo, timeoutMs = 120_000): Promise<string> {
    const request = session?.model ? { prompt, model: session.model } : { prompt }
    const controller = new AbortController()
    const dispose = () => controller.abort()
    if (this.controller.signal.aborted) controller.abort()
    else this.controller.signal.addEventListener("abort", dispose, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return (await this.ctx.generate.text(request, { signal: controller.signal })).text
    } catch (error) {
      if (controller.signal.aborted) return ""
      throw error
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener("abort", dispose)
    }
  }

  private async dedupCheck(
    session: SessionInfo,
    entries: Entry[],
    candidates: { text: string }[],
  ): Promise<Set<number>> {
    const skip = new Set<number>()
    if (candidates.length === 0 || entries.length === 0) return skip
    const entryLines = entries.map((entry) => `${entry.id} | ${entry.source} | ${entry.category} | ${entry.text}`).join("\n")
    const candidateLines = candidates.map((candidate, index) => `[${index}] ${candidate.text}`).join("\n")
    const prompt = `You are a deduplication checker for a memory store.

EXISTING MEMORY ENTRIES:
${entryLines}

CANDIDATE NEW FACTS:
${candidateLines}

For each candidate that is semantically equivalent to an existing entry (same meaning, ANY language, paraphrase), reply with that candidate's index in "duplicates". An entry with source=explicit always wins over a candidate. Candidates that describe something NEW are not duplicates.

REPLY WITH STRICT JSON ONLY:
{"duplicates":[0,2]}`
    try {
      const answer = await this.generate(prompt, session, 90_000)
      const parsed = extractJson(answer)
      const duplicates = Array.isArray(parsed?.duplicates) ? parsed.duplicates : []
      for (const duplicate of duplicates) {
        const index = Number(duplicate)
        if (Number.isInteger(index) && index >= 0 && index < candidates.length) skip.add(index)
      }
    } catch (error) {
      this.log("debug", "dedup check failed", { error: String(error) })
    }
    return skip
  }

  private async consolidate(sessionID: string) {
    const session = await this.sessionInfo(sessionID)
    if (!session) return
    const messages = await this.ctx.session.context({ sessionID })
    const lastTs = messages.reduce((max, message) => Math.max(max, messageTimestamp(message)), 0)
    const state = await this.store.getState()
    if (lastTs <= (state.sessions[sessionID] ?? 0)) return

    const inProgress = state.inProgress?.[sessionID]
    if (inProgress && now() - inProgress.startedAt < this.config.inProgressTimeoutMs) return

    const transcript = messages
      .map((message) => `${message.type}: ${messageText(message)}`)
      .join("\n\n")
      .slice(-this.config.transcriptChars)
    const messageIDs = messages.map((message) => String(message.id)).slice(-20)
    const directory = session.location.directory
    const store = await this.store.getStore()
    const visible = consolidationEntries(store, directory)
    const entriesBlock =
      visible.length === 0
        ? "(none)"
        : visible
            .map((entry) => `- [${entry.id}] (${entry.scope}/${entry.category}, w=${entry.weight.toFixed(1)}, source=${entry.source}) ${entry.text}`)
            .join("\n")

    const prompt = `You are the memory consolidation module of OpenCode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory. Be concise, third person ("The user...").
2. update: only entries whose fact genuinely CHANGED in the conversation. Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. conflicts: if the conversation STRONGLY contradicts an entry tagged source=explicit, report it with the entry id and a short evidence quote. Never modify or delete that entry.
${this.config.summary ? "5. summary: 2-5 sentence summary of who the user is and how they like to work. NEVER include sensitive data in the summary." : ""}

SOURCE HIERARCHY:
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed entries.
- NEVER add a new fact semantically equivalent to an explicit entry, in any language or wording.
- A fact about the same user attribute/topic is a duplicate unless it describes a different attribute.
- NEVER delete or update explicit entries; use conflicts instead.
- If a new fact duplicates a dreamed entry, delete the old dreamed id and add the better formulation.
- If a dreamed entry contradicts an explicit one, delete the dreamed entry.

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing is new, return empty arrays${this.config.summary ? ' but still a summary (or "" if unchanged)' : ''}.
- Write facts in the same language the user used.
- Compare meaning across languages before adding a fact.
- Use scope "project" only for facts tied to this codebase; otherwise use "global".
- Optionally attach confidence (0-1) to each new fact.

RESPOND WITH STRICT JSON ONLY:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project","confidence":0.9}],"update":[{"id":"...","text":"..."}],"delete":["..."],"conflicts":[{"id":"...","evidence":"..."}]${this.config.summary ? ',"summary":"..."' : ''}}

CURRENT MEMORY ENTRIES:
${entriesBlock}

TRANSCRIPT (session title: ${session.title ?? ""}):
${transcript}`

    state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
    await this.store.saveState(state)
    let completed = false
    try {
      const answer = await this.generate(prompt, session)
      if (!answer) throw new Error("consolidation timed out")
      const parsed = extractJson(answer)
      if (!parsed || !Array.isArray(parsed.new)) throw new Error("consolidation returned no usable JSON")
      if (!this.config.summary) delete parsed.summary

      if (parsed.new.length > 0 && visible.length > 0) {
        const skip = await this.dedupCheck(session, visible, parsed.new)
        parsed.new = parsed.new.filter((_: unknown, index: number) => !skip.has(index))
      }

      await this.store.withLock(async () => {
        const fresh = await this.store.getStore()
        applyConsolidation(fresh, parsed, directory, now(), this.log.bind(this), {
          sessionID,
          messageIDs,
        })
        prune(fresh, now(), this.config.maxEntries)
        await this.store.writeStore(fresh)
      })
      state.sessions[sessionID] = lastTs
      completed = true
      this.log("info", "consolidated session", { sessionID, newFacts: parsed.new.length })
    } finally {
      if (completed) delete state.inProgress![sessionID]
      else state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
      await this.store.saveState(state).catch(() => {})
    }
  }

  private async sessionTopicQuery(sessionID: string): Promise<string> {
    try {
      const messages = await this.ctx.session.context({ sessionID })
      const lastUser = [...messages].reverse().find((message) => message.type === "user")
      return lastUser?.type === "user" ? lastUser.text : ""
    } catch {
      return ""
    }
  }

  private async rerank(
    session: SessionInfo,
    sessionID: string,
    query: string,
    candidates: RankedMemory[],
  ): Promise<RankedMemory[]> {
    if (candidates.length <= 1) return candidates
    const key = query.trim().toLowerCase() || " "
    const cached = this.rerankCache.get(key)
    if (cached && now() - cached.at < this.config.rerankCacheMs) {
      if (cached.abstain) return []
      const positions = new Map(cached.order.map((id, index) => [id, index]))
      return [...candidates].sort((a, b) => {
        const left = positions.get(a.entry.id)
        const right = positions.get(b.entry.id)
        if (left === undefined && right === undefined) return b.base - a.base
        if (left === undefined) return 1
        if (right === undefined) return -1
        return left - right
      })
    }

    const visible = candidates.filter((candidate) => candidate.entry.sensitivity !== "local-only")
    if (visible.length <= 1) return candidates
    const lines = visible.map((candidate, index) => `[${index}] ${candidate.entry.text}`).join("\n")
    const prompt = `You are a memory retrieval judge. Decide which candidate memories actually help answer the user's question, then rank ONLY those, most relevant first. Use semantics, not just keywords. Exclude adjacent topics that do not answer the question.

REPLY WITH STRICT JSON ONLY:
- {"order":[i,j,...]} for relevant candidates, best first
- {"order":[]} if NO candidate answers the question

QUESTION: ${query || "(empty)"}

CANDIDATES:
${lines}`
    try {
      const answer = await this.generate(prompt, session, this.config.rerankTimeoutMs)
      if (!answer) return candidates
      const outcome = parseRerankAnswer(answer, visible.length)
      if (outcome.kind === "abstain") {
        this.rerankCache.set(key, { at: now(), order: [], abstain: true })
        return []
      }
      if (outcome.kind === "invalid") return candidates
      const ordered = applyRerankOrderAnswer(visible, outcome)
      const order = ordered.map((candidate) => candidate.entry.id)
      this.rerankCache.set(key, { at: now(), order })
      const selected = new Set(order)
      return [...ordered, ...candidates.filter((candidate) => !selected.has(candidate.entry.id))]
    } catch (error) {
      this.log("debug", "rerank failed; lexical fallback", { sessionID, error: String(error) })
      return candidates
    }
  }

  private async markSurfaced(ids: string[], time = now()) {
    if (ids.length === 0) return
    try {
      await this.store.withLock(async () => {
        const store = await this.store.getStore()
        const due = ids.some((id) => {
          const entry = store.entries.find((candidate) => candidate.id === id)
          return !!entry && time - (entry.lastUsed ?? 0) >= this.config.surfaceRefreshMs
        })
        if (!due) return
        applySurfaceFeedback(store, ids, time, this.config.surfaceRefreshMs)
        await this.store.writeStore(store)
      })
    } catch (error) {
      this.log("debug", "markSurfaced failed", { error: String(error) })
    }
  }

  private async buildMemoryBlock(sessionID: string): Promise<string | undefined> {
    const store = await this.store.getStore()
    if (store.entries.length === 0 && !(this.config.summary && store.summary)) return undefined
    const session = await this.sessionInfo(sessionID)
    if (!session) return undefined
    const directory = session.location.directory
    const time = now()
    const query = await this.sessionTopicQuery(sessionID)
    const ranked = retrieve(store, directory, query, time, {
      excludeSensitivity: new Set(["local-only"]),
      candidateCount: this.config.rerankCandidates,
    })
    const reranked = this.config.rerank ? await this.rerank(session, sessionID, query, ranked) : ranked
    const qualified = this.config.rerank ? reranked : reranked.filter(passesRelevanceGate)
    const top = qualified.slice(0, this.config.maxFacts)
    const selected = new Set(top.map((candidate) => candidate.entry.id))
    const core = coreSlot(store, directory, selected, time, this.config.coreSlot)
    const surfaced: RankedMemory[] = [
      ...top,
      ...core.map((entry, index) => ({
        entry,
        base: score(entry, time),
        keywordHits: 0,
        matches: [],
        core: true,
        rank: top.length + index + 1,
        final: score(entry, time),
      })),
    ]
    this.lastSurface.set(sessionID, surfaced)
    void this.markSurfaced(surfaced.map((candidate) => candidate.entry.id), time)

    const lines = [
      "<memory>",
      "The following is long-term memory from previous conversations with this user. Use it to personalize responses and follow established preferences. If something contradicts newer information, trust the newer information.",
    ]
    if (this.config.summary && store.summary) lines.push(`<summary>${store.summary}</summary>`)
    if (surfaced.length > 0) {
      lines.push("<facts>")
      for (const candidate of surfaced) {
        const entry = candidate.entry
        const status = entry.status === "CONFLICTED" ? ", conflicted" : ""
        lines.push(`- [${entry.source}] (${entry.category}${status}) ${entry.text}`)
      }
      lines.push("</facts>")
    }
    lines.push("</memory>")
    let block = lines.join("\n")
    if (block.length > this.config.maxChars) block = `${block.slice(0, this.config.maxChars - 1)}…`
    return block
  }

  private async registerTools() {
    const tools = this.tools()
    this.registrations.push(await this.ctx.tool.transform((editor) => {
      for (const definition of tools) {
        editor.add({
          name: definition.name,
          description: definition.description,
          input: definition.input,
          execute: async (input, context) => ({
            content: await definition.execute(input as ToolArgs, { sessionID: String(context.sessionID) }),
          }),
        })
      }
    }))
  }

  private tools(): MemoryTool[] {
    const categoryDescription = "Optional category: user, project, workflow, preferences, decisions, status, environment, other"
    return [
      {
        name: "memory_read",
        description: "Read facts stored in long-term memory. Returns global facts plus the current project's facts; other projects and local-only entries are never visible.",
        input: objectSchema({
          query: { type: "string", description: "Optional text to filter facts by topic" },
          category: { type: "string", description: categoryDescription },
          scope: { type: "string", enum: ["global", "project"], description: "Filter by scope" },
        }),
        execute: async (args, context) => {
          const store = await this.store.getStore()
          const directory = await this.directoryFor(context.sessionID)
          const hits = readQuery(store, directory, {
            query: args.query ? String(args.query) : undefined,
            category: args.category ? String(args.category) : undefined,
            scope: args.scope === "project" ? "project" : args.scope === "global" ? "global" : undefined,
          })
          if (hits.length === 0) return "No memory entries found."
          return [
            this.config.summary && store.summary ? `Summary: ${store.summary}` : null,
            ...hits.map((entry) => `- [${entry.id}] (${entry.scope}/${entry.category}, ${entry.source}) ${entry.text}`),
          ].filter(Boolean).join("\n")
        },
      },
      {
        name: "memory_write",
        description: "Store a durable fact about the user or project. Distinct facts are kept separately; repeating the same text refreshes it and resolves any conflict. Use memory_update to correct an existing fact.",
        input: objectSchema({
          fact: { type: "string", description: "The fact to remember, written in third person" },
          category: { type: "string", description: categoryDescription },
          scope: { type: "string", enum: ["global", "project"], description: "Global applies everywhere; project only in this codebase" },
          tier: { type: "string", enum: ["core", "archival", "temporary"], description: "Memory lifecycle tier" },
          ttlHours: { type: "number", description: "Lifetime in hours for a temporary memory (default 24)" },
          pinned: { type: "boolean", description: "Pinned memories never decay" },
          sensitivity: { type: "string", enum: ["normal", "private", "local-only"], description: "local-only is stored on disk and never exposed to a model or tool" },
        }, ["fact"]),
        execute: async (args, context) => {
          const text = String(args.fact ?? "").trim()
          if (!text) return "No fact provided."
          const directory = await this.directoryFor(context.sessionID)
          const scope: Entry["scope"] = args.scope === "project" ? "project" : "global"
          const tier: Entry["tier"] = args.tier === "temporary" || args.tier === "archival" || args.tier === "core" ? args.tier : undefined
          const sensitivity: Entry["sensitivity"] = args.sensitivity === "private" || args.sensitivity === "local-only" ? args.sensitivity : undefined
          const expiresAt = tier === "temporary" ? now() + Number(args.ttlHours ?? 24) * 60 * 60 * 1000 : undefined
          let status = ""
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            const existing = findWritableTarget(fresh.entries, text, scope, directory, sensitivity === "local-only")
            if (existing) {
              existing.text = text
              existing.source = "explicit"
              existing.weight = Math.min(4, existing.weight + 0.5)
              existing.lastSeen = now()
              existing.createdBy = "memory_write"
              existing.confidence = 1
              if (tier) existing.tier = tier
              if (existing.tier !== "temporary") existing.expiresAt = undefined
              if (args.pinned === true) existing.pinned = true
              if (args.pinned === false) existing.pinned = false
              if (sensitivity) existing.sensitivity = sensitivity
              if (args.category) existing.category = String(args.category)
              if (scope === "project" && !existing.projectID) existing.projectID = directory
              if (existing.status === "CONFLICTED") {
                existing.status = "ACTIVE"
                existing.conflictEvidence = undefined
                existing.conflictAt = undefined
                status = " (conflict resolved)"
              }
            } else {
              addEntry(fresh, {
                text,
                category: String(args.category ?? "other"),
                scope,
                projectID: scope === "project" ? directory : undefined,
                weight: 3,
                lastSeen: now(),
                source: "explicit",
                created: now(),
                createdBy: "memory_write",
                confidence: 1,
                tier: tier ?? (String(args.category ?? "other") === "other" ? "archival" : "core"),
                pinned: args.pinned === true ? true : undefined,
                expiresAt,
                sensitivity: sensitivity ?? "normal",
              })
            }
            fresh.updatedAt = now()
            prune(fresh, now(), this.config.maxEntries)
            await this.store.writeStore(fresh)
          })
          return `Remembered (${scope})${status}: ${text}`
        },
      },
      {
        name: "memory_update",
        description: "Correct an existing visible memory by id or matching text. Resolves a conflicted entry.",
        input: objectSchema({
          id: { type: "string", description: "Entry id from memory_read" },
          match: { type: "string", description: "Text of the entry to update" },
          fact: { type: "string", description: "The corrected fact" },
        }, ["fact"]),
        execute: async (args, context) => {
          const fact = String(args.fact ?? "").trim()
          if (!fact) return "No fact provided."
          const directory = await this.directoryFor(context.sessionID)
          let updated = 0
          let resolvedConflict = false
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            const visible = readableEntries(fresh, directory)
            const target = args.id
              ? visible.find((entry) => entry.id === args.id)
              : args.match
                ? findSimilar(visible, String(args.match))
                : undefined
            if (target) {
              target.text = fact
              target.weight = Math.min(4, target.weight + 0.5)
              target.lastSeen = now()
              if (target.status === "CONFLICTED") {
                target.status = "ACTIVE"
                target.conflictEvidence = undefined
                target.conflictAt = undefined
                resolvedConflict = true
              }
              updated = 1
            }
            fresh.updatedAt = now()
            await this.store.writeStore(fresh)
          })
          return updated ? `Updated: ${fact}${resolvedConflict ? " (conflict resolved)" : ""}` : "No matching entry found."
        },
      },
      {
        name: "memory_why",
        description: "Explain a memory's provenance, lifecycle status and current score breakdown.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) => {
          const store = await this.store.getStore()
          const directory = await this.directoryFor(context.sessionID)
          const entry = readableEntries(store, directory).find((candidate) => candidate.id === args.id)
          if (!entry) return "No memory entry with this id."
          const time = now()
          const days = Math.max(0, (time - entry.lastSeen) / DAY)
          const decay = Math.exp(-days / 45)
          const base = score(entry, time)
          const lines = [
            `Text: ${entry.text}`,
            `Source: ${entry.source}${entry.createdBy ? ` (via ${entry.createdBy})` : ""}`,
            `Category: ${entry.category} | Scope: ${entry.scope}${entry.projectID ? ` | project: ${entry.projectID}` : ""}`,
          ]
          if (entry.source === "dreamed") {
            lines.push(`Extracted: ${entry.extractedAt ? new Date(entry.extractedAt).toISOString() : "unknown"}`)
            if (entry.sourceSessionID) lines.push(`From session: ${entry.sourceSessionID}`)
            if (entry.sourceMessageIDs?.length) lines.push(`From messages: ${entry.sourceMessageIDs.join(", ")}`)
            if (entry.confidence !== undefined) lines.push(`Confidence: ${(entry.confidence * 100).toFixed(0)}%`)
          } else {
            lines.push(`Stated directly by the user (${entry.created ? new Date(entry.created).toISOString() : "date unknown"})`)
          }
          lines.push(`Lifecycle: ${entry.status ?? "ACTIVE"}${entry.pinned ? " | pinned (no decay)" : ""}${entry.tier ? ` | tier ${entry.tier}` : ""}${entry.expiresAt ? ` | expires ${new Date(entry.expiresAt).toISOString()}` : ""}`)
          if (entry.status === "CONFLICTED") {
            lines.push(`Conflict: flagged on ${entry.conflictAt ? new Date(entry.conflictAt).toISOString() : "?"}`)
            lines.push(`Evidence: ${entry.conflictEvidence ?? "—"}`)
            lines.push("Resolve it with memory_update or memory_write.")
          }
          lines.push(`Weight: ${entry.weight.toFixed(2)} (base importance, never decayed in place)`)
          lines.push(`Usage: surfaced ${entry.surfacedCount ?? 0}x (last ${entry.lastSurfaced ? new Date(entry.lastSurfaced).toISOString() : "never"}), helpful ${entry.helpfulCount ?? 0}, irrelevant ${entry.irrelevantCount ?? 0}`)
          lines.push(`Score (now): ${base.toFixed(3)} = (${entry.weight.toFixed(2)} + source bonus + utilization) × decay ${decay.toFixed(3)} (age since last confirmation ${Math.round(days)}d)`)
          for (const [sessionID, ranked] of this.lastSurface) {
            const hit = ranked.find((candidate) => candidate.entry.id === entry.id)
            if (!hit) continue
            lines.push(`Last surfacing (session ${sessionID}):`)
            lines.push(`  Base score: ${hit.base.toFixed(2)}`)
            lines.push(`  Keyword match: ${hit.keywordHits > 0 ? `+${hit.keywordHits * KEYWORD_BONUS} (${hit.keywordHits} hits)` : "+0"}`)
            lines.push(`  Core slot: ${hit.core ? "yes" : "no"}`)
            lines.push(`  Final rank: #${hit.rank}`)
          }
          lines.push(`Sensitivity: ${entry.sensitivity ?? "normal"}`)
          return lines.join("\n")
        },
      },
      {
        name: "memory_inspect",
        description: "Inspect visible memory statistics, recent facts, conflicts, project facts, or the current session's surfacing breakdown.",
        input: objectSchema({
          show: { type: "string", enum: ["stats", "recent", "conflicts", "project", "surfaced"], description: "View to show (default stats)" },
          limit: { type: "number", description: "Maximum entries in list views (default 10)" },
        }),
        execute: async (args, context) => {
          const store = await this.store.getStore()
          const directory = await this.directoryFor(context.sessionID)
          const visible = readableEntries(store, directory)
          const show = args.show ?? "stats"
          const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)))
          const output: string[] = []
          if (show === "stats") {
            const count = (predicate: (entry: Entry) => boolean) => visible.filter(predicate).length
            const categories = new Map<string, number>()
            for (const entry of visible) categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1)
            const avgChars = visible.length ? Math.round(visible.reduce((sum, entry) => sum + entry.text.length, 0) / visible.length) : 0
            output.push("OpenCode Memory (visible in this project)", "")
            output.push(`Stored: ${visible.length}   Explicit: ${count((entry) => entry.source === "explicit")}   Dreamed: ${count((entry) => entry.source === "dreamed")}`)
            output.push(`Global: ${count((entry) => entry.scope === "global")}   Project: ${count((entry) => entry.scope === "project")}`)
            output.push(`Tier: core ${count((entry) => entry.tier === "core")} | archival ${count((entry) => entry.tier === "archival")} | temporary ${count((entry) => entry.tier === "temporary")} | pinned ${count((entry) => !!entry.pinned)}`)
            output.push(`Status: conflicted ${count((entry) => entry.status === "CONFLICTED")} | superseded ${count((entry) => entry.status === "SUPERSEDED")}`)
            output.push(`Sensitivity: private ${count((entry) => entry.sensitivity === "private")}`)
            output.push(`Categories: ${[...categories.entries()].map(([category, total]) => `${category} ${total}`).join(", ")}`)
            const summaryChars = this.config.summary ? store.summary.length : 0
            output.push(`Summary: ${this.config.summary ? `${summaryChars} chars` : "disabled"}   Avg fact: ${avgChars} chars   Est. full context cost: ${Math.round((summaryChars + visible.reduce((sum, entry) => sum + entry.text.length, 0)) / 4)} tokens`)
            output.push(`Surfaced in last prompts: ${[...this.lastSurface.values()].reduce((sum, ranked) => sum + ranked.length, 0)}/${visible.length}`)
            output.push("(local-only entries are never listed here; manage them via files in the memory dir)")
          } else if (show === "recent") {
            const entries = [...visible].sort((a, b) => b.created - a.created).slice(0, limit)
            output.push(`Recent ${entries.length} entries:`)
            for (const entry of entries) output.push(`- [${entry.id}] (${entry.scope}/${entry.category}, ${entry.source}${entry.status === "CONFLICTED" ? ", conflicted" : ""}) ${entry.text}`)
          } else if (show === "conflicts") {
            const entries = visible.filter((entry) => entry.status === "CONFLICTED")
            if (entries.length === 0) output.push("No conflicts awaiting resolution.")
            else {
              output.push(`${entries.length} conflicted explicit memor${entries.length === 1 ? "y" : "ies"} (resolve with memory_update):`)
              for (const entry of entries) {
                output.push(`- [${entry.id}] ${entry.text}`)
                output.push(`  evidence: ${entry.conflictEvidence ?? "—"} (flagged ${entry.conflictAt ? new Date(entry.conflictAt).toISOString() : "?"})`)
              }
            }
          } else if (show === "project") {
            const entries = visible.filter((entry) => entry.scope === "project" && entry.projectID === directory).slice(0, limit)
            output.push(`Project entries (directory: ${directory ?? "unknown"}) — ${entries.length}/${visible.filter((entry) => entry.scope === "project").length}:`)
            for (const entry of entries) output.push(`- [${entry.id}] (${entry.category}, ${entry.source}) ${entry.text}`)
          } else if (show === "surfaced") {
            const ranked = this.lastSurface.get(context.sessionID)
            if (!ranked?.length) output.push("No memory surfaced for this session yet. Send a message to trigger retrieval.")
            else {
              output.push(`Why was this memory surfaced? (session ${context.sessionID}, latest retrieval)`, "")
              for (const candidate of ranked) {
                output.push(`Memory: "${candidate.entry.text}"`)
                output.push(`  Base score:      ${candidate.base.toFixed(2)}`)
                output.push(`  Keyword match:   ${candidate.keywordHits > 0 ? `+${(candidate.keywordHits * KEYWORD_BONUS).toFixed(2)} (${candidate.keywordHits} hits)` : "+0.00"}`)
                output.push(`  Core bonus:      ${candidate.core ? "yes" : "no"}`)
                output.push(`  Final rank:      #${candidate.rank}`, "")
              }
            }
          }
          return output.join("\n")
        },
      },
      {
        name: "memory_useful",
        description: "Mark a surfaced memory useful, improving ranking and confirming that it is still current.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) => {
          const directory = await this.directoryFor(context.sessionID)
          let ok = false
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            if (!readableEntries(fresh, directory).some((entry) => entry.id === args.id)) return
            ok = applyUsefulFeedback(fresh, String(args.id), now())
            if (ok) {
              fresh.updatedAt = now()
              await this.store.writeStore(fresh)
            }
          })
          return ok ? "Noted as useful." : "No memory entry with this id."
        },
      },
      {
        name: "memory_irrelevant",
        description: "Mark a surfaced memory irrelevant to the current task, lowering future ranking without changing factual recency.",
        input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
        execute: async (args, context) => {
          const directory = await this.directoryFor(context.sessionID)
          let ok = false
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            if (!readableEntries(fresh, directory).some((entry) => entry.id === args.id)) return
            ok = applyIrrelevantFeedback(fresh, String(args.id), now())
            if (ok) {
              fresh.updatedAt = now()
              await this.store.writeStore(fresh)
            }
          })
          return ok ? "Noted as irrelevant." : "No memory entry with this id."
        },
      },
      {
        name: "memory_forget",
        description: "Remove a visible memory by id or matching text.",
        input: objectSchema({
          id: { type: "string", description: "Entry id from memory_read" },
          match: { type: "string", description: "Text of the entry to delete" },
        }),
        execute: async (args, context) => {
          const directory = await this.directoryFor(context.sessionID)
          let removed = 0
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            const forgettable = new Set(readableEntries(fresh, directory).map((entry) => entry.id))
            const before = fresh.entries.length
            fresh.entries = fresh.entries.filter((entry) => {
              if (!forgettable.has(entry.id)) return true
              if (args.id && entry.id === args.id) return false
              if (args.match) {
                const match = String(args.match).toLowerCase()
                if (match.length > 3 && entry.text.toLowerCase().includes(match)) return false
              }
              return true
            })
            removed = before - fresh.entries.length
            if (removed) fresh.summary = ""
            fresh.updatedAt = now()
            await this.store.writeStore(fresh)
          })
          return removed ? `Forgot ${removed} entr${removed === 1 ? "y" : "ies"}.` : "No matching entry found."
        },
      },
      {
        name: "memory_clear",
        description: "Delete stored memory. summaryOnly=true clears just the shared summary and retains all facts; omit scope in that case. Otherwise project scope clears this project, global clears shared facts, and no arguments wipe everything including local-only entries.",
        input: objectSchema({
          scope: { type: "string", enum: ["global", "project"], description: "Only clear this scope; default clears everything" },
          summaryOnly: { type: "boolean", description: "Clear only the summary, retaining all facts; cannot be combined with scope" },
        }),
        execute: async (args, context) => {
          if (args.summaryOnly && args.scope) return "The summary is shared; omit scope when using summaryOnly."
          const directory = await this.directoryFor(context.sessionID)
          let removed = 0
          await this.store.withLock(async () => {
            const fresh = await this.store.getStore()
            const before = fresh.entries.length
            if (args.summaryOnly) {
              fresh.summary = ""
            } else if (args.scope === "project") {
              removed = clearProjectEntries(fresh, directory)
            } else if (args.scope === "global") {
              fresh.entries = fresh.entries.filter((entry) => entry.scope !== "global")
              removed = before - fresh.entries.length
            } else {
              fresh.entries = []
              removed = before
            }
            if (removed || (!args.scope && !args.summaryOnly)) fresh.summary = ""
            fresh.updatedAt = now()
            await this.store.writeStore(fresh)
          })
          if (args.summaryOnly) return "Cleared memory summary; retained all facts."
          return removed ? `Cleared ${removed} memory entr${removed === 1 ? "y" : "ies"}.` : "Memory already empty."
        },
      },
    ]
  }
}

export async function setupV2(ctx: Plugin.Context) {
  const runtime = new V2MemoryRuntime(ctx)
  return runtime.setup()
}
