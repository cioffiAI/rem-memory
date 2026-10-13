import type { Plugin } from "@opencode/plugin"
import { isDirExplicit, resolveConfig, type MemoryConfig } from "../config.ts"
import { buildCommandPrompt, COMMAND_DESCRIPTION, COMMAND_NAME } from "../engine/command.ts"
import { consolidate } from "../engine/dream.ts"
import { writeMechanicalHandoff } from "../engine/handoff.ts"
import type { ChangedFile, Host, LogLevel, SessionRef, TranscriptMessage } from "../engine/host.ts"
import { createSurface } from "../engine/surface.ts"
import { createTools, MEMORY_TOOL_NAMES } from "../engine/tools.ts"
import { createStore, migrateLegacyStore, type StoreIO } from "../store.ts"

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

function now() {
  return Date.now()
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

// Completed tool parts carry the file paths needed outside git; `snapshot`
// (assistant messages only, git projects only) lists files changed per message.
function normalizeMessage(message: SessionMessage): TranscriptMessage {
  const normalized: TranscriptMessage = {
    id: String(message.id),
    type: message.type,
    text: messageText(message),
    time: messageTimestamp(message),
  }
  if (message.type === "assistant") {
    const tools = (message.content as Array<{ type: string; name?: string; state?: { status?: string; input?: unknown } }>)
      .filter((part) => part.type === "tool" && part.state?.status === "completed" && typeof part.name === "string")
      .map((part) => ({ name: part.name!, input: (part.state?.input ?? {}) as Record<string, unknown> }))
    if (tools.length > 0) normalized.tools = tools
    const files = (message as { snapshot?: { files?: unknown } }).snapshot?.files
    if (Array.isArray(files)) normalized.snapshotFiles = files.filter((file): file is string => typeof file === "string")
  }
  return normalized
}

class V2MemoryRuntime {
  private readonly queue: string[] = []
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>()
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
  private readonly host: Host
  private readonly deps: { host: Host; config: MemoryConfig; store: StoreIO }
  private readonly surface: ReturnType<typeof createSurface>

  constructor(private readonly ctx: Plugin.Context) {
    this.config = resolveConfig(ctx.options)
    this.dirExplicit = isDirExplicit(ctx.options)
    this.store = createStore(this.config.dir)
    this.host = this.createHost()
    this.deps = { host: this.host, config: this.config, store: this.store }
    this.surface = createSurface(this.deps)
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

  private createHost(): Host {
    const ctx = this.ctx
    return {
      name: "opencode",
      session: async (sessionID) => {
        const session = await this.sessionInfo(sessionID)
        return session ? { directory: session.location.directory, title: session.title ?? undefined } satisfies SessionRef : undefined
      },
      directoryFor: (sessionID) => this.directoryFor(sessionID),
      generate: async (prompt, opts) => this.generate(prompt, opts.sessionID ? await this.sessionInfo(opts.sessionID) : undefined, opts.timeoutMs),
      transcript: async (sessionID) => (await ctx.session.context({ sessionID })).map(normalizeMessage),
      lastUserText: async (sessionID) => {
        try {
          const messages = await ctx.session.context({ sessionID })
          const lastUser = [...messages].reverse().find((message) => message.type === "user")
          return lastUser?.type === "user" ? lastUser.text : ""
        } catch {
          return ""
        }
      },
      // ctx.vcs is bound to the plugin's own directory and ignores any other.
      vcs: ctx.vcs
        ? async (directory) => {
            if (directory !== ctx.location.directory) return undefined
            try {
              const [info, status] = await Promise.all([ctx.vcs.get(), ctx.vcs.status()])
              return { branch: info.data.branch.current, changed: status.data as ChangedFile[] }
            } catch (error) {
              this.log("debug", "vcs failed", { error: String(error) })
              return undefined
            }
          }
        : undefined,
      log: (level, message, extra) => this.log(level, message, extra),
    }
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
      if (this.config.command) await this.registerCommand()
      if (this.config.surface) {
        this.registrations.push(await this.ctx.session.hook("context", async (event) => {
          try {
            const block = await this.surface.buildMemoryBlock(String(event.sessionID))
            if (block) event.system.push({ type: "text", text: block })
          } catch (error) {
            this.log("debug", "context hook failed", { error: String(error) })
          }
        }))
      }

      if (this.config.dream || this.config.handoff) this.eventTask = this.consumeEvents()
      if (this.config.dream) {
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
        this.log("debug", "session completed", { sessionID, event: event.type })
        // The mechanical handoff is written right away: it must not wait for
        // the DREAM debounce, nor depend on DREAM being enabled.
        if (this.config.handoff) {
          await writeMechanicalHandoff(this.deps, sessionID).catch((error) => {
            this.log("warn", "handoff write failed", { sessionID, error: String(error) })
          })
        }
        if (this.config.dream) this.scheduleConsolidation(sessionID)
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
          await consolidate(this.deps, sessionID)
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


  // command.execute does not query the model by itself: forward the
  // instructions (plus the user's arguments) as a prompt for that session.
  private async registerCommand() {
    // Older/partial hosts may not expose the command domain; tools still work.
    if (!this.ctx.command) return
    this.registrations.push(await this.ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        execute: async (invocation) => {
          await this.ctx.session.prompt({
            sessionID: String(invocation.sessionID),
            text: buildCommandPrompt(invocation.prompt.text),
            delivery: invocation.delivery,
          })
        },
      })
    }))
  }

  private async registerTools() {
    const tools = createTools(this.deps, this.surface)
    this.registrations.push(await this.ctx.tool.transform((editor) => {
      for (const definition of tools) {
        editor.add({
          name: definition.name,
          description: definition.description,
          input: definition.input,
          execute: async (input, context) => ({
            content: await definition.execute(input as Record<string, unknown>, { sessionID: String(context.sessionID) }),
          }),
        })
      }
    }))
  }
}

export async function setupV2(ctx: Plugin.Context) {
  const runtime = new V2MemoryRuntime(ctx)
  return runtime.setup()
}
