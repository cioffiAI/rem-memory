// The memory_* tools as host-neutral definitions; adapters register them with
// whatever tool API their host offers.

import {
  addEntry,
  clearProjectEntries,
  applyIrrelevantFeedback,
  applyUsefulFeedback,
  DAY,
  findSimilar,
  findWritableTarget,
  KEYWORD_BONUS,
  prune,
  readQuery,
  readableEntries,
  score,
  type Anchor,
  type Entry,
} from "../core.ts"
import {
  anchorLabel,
  AnchorError,
  createAnchorCache,
  createAnchors,
  describeCheck,
  entryAnchorState,
  refreshAnchors,
} from "./anchors.ts"
import type { EngineDeps } from "./host.ts"
import type { Surface } from "./surface.ts"

type ToolArgs = Record<string, unknown>
type JsonSchema = Record<string, unknown>

export type MemoryTool = {
  name: string
  description: string
  input: JsonSchema
  execute: (args: ToolArgs, context: { sessionID: string }) => Promise<string>
}

export const MEMORY_TOOL_NAMES = [
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

export function createTools({ host, config, store: storeIO }: EngineDeps, surface: Surface): MemoryTool[] {
  const categoryDescription = "Optional category: user, project, workflow, preferences, decisions, status, environment, other"
  const anchorCache = createAnchorCache()
  const anchorsDescription =
    'Optional code anchors for a project fact: up to 3 files of this project, as "src/store.ts" or "src/store.ts#symbol". The memory is flagged when that code changes and hidden when the file or symbol disappears. Project scope only.'
  const anchorMessage = (error: unknown) => `Invalid anchor: ${error instanceof AnchorError ? error.message : String(error)} Nothing was saved.`
  const anchorsShapeError = () =>
    anchorMessage(new AnchorError("invalid", 'anchors must be an array of strings like "src/x.ts" or "src/x.ts#symbol".'))
  // Suffix shown by memory_read next to anchored entries.
  const staleMarker = async (entry: Entry) => {
    if (!entry.anchors?.length) return ""
    const anchorState = await entryAnchorState(entry, anchorCache)
    if (anchorState.state === "drifted") return " [drifted]"
    if (anchorState.state === "broken") {
      return ` [stale: ${anchorState.checks.filter((check) => check.state === "broken").map(describeCheck).join("; ")}]`
    }
    return ""
  }
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
        const store = await storeIO.getStore()
        const directory = await host.directoryFor(context.sessionID)
        const hits = readQuery(store, directory, {
          query: args.query ? String(args.query) : undefined,
          category: args.category ? String(args.category) : undefined,
          scope: args.scope === "project" ? "project" : args.scope === "global" ? "global" : undefined,
        })
        if (hits.length === 0) return "No memory entries found."
        const lines: string[] = []
        for (const entry of hits) {
          lines.push(`- [${entry.id}] (${entry.scope}/${entry.category}, ${entry.source}) ${entry.text}${await staleMarker(entry)}`)
        }
        return [config.summary && store.summary ? `Summary: ${store.summary}` : null, ...lines].filter(Boolean).join("\n")
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
        anchors: { type: "array", items: { type: "string" }, description: anchorsDescription },
      }, ["fact"]),
      execute: async (args, context) => {
        const text = String(args.fact ?? "").trim()
        if (!text) return "No fact provided."
        const directory = await host.directoryFor(context.sessionID)
        const scope: Entry["scope"] = args.scope === "project" ? "project" : "global"
        const tier: Entry["tier"] = args.tier === "temporary" || args.tier === "archival" || args.tier === "core" ? args.tier : undefined
        const sensitivity: Entry["sensitivity"] = args.sensitivity === "private" || args.sensitivity === "local-only" ? args.sensitivity : undefined
        const expiresAt = tier === "temporary" ? now() + Number(args.ttlHours ?? 24) * 60 * 60 * 1000 : undefined
        let anchors: Anchor[] | undefined
        if (args.anchors !== undefined && !Array.isArray(args.anchors)) return anchorsShapeError()
        if (Array.isArray(args.anchors) && args.anchors.length > 0) {
          if (scope !== "project") return 'Anchors are only allowed on project-scoped facts (set scope "project"). Nothing was saved.'
          if (!directory) return "Invalid anchor: the project directory is unknown. Nothing was saved."
          try {
            anchors = await createAnchors(args.anchors, directory, now(), anchorCache)
          } catch (error) {
            return anchorMessage(error)
          }
        }
        let status = ""
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
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
            if (anchors) existing.anchors = anchors
            else if (existing.anchors?.length) existing.anchors = await refreshAnchors(existing.anchors, existing.projectID, now(), anchorCache)
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
              ...(anchors ? { anchors } : {}),
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
          prune(fresh, now(), config.maxEntries)
          await storeIO.writeStore(fresh)
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
        anchors: { type: "array", items: { type: "string" }, description: `${anchorsDescription} Replaces the entry's anchors; an empty list removes them. Omit to keep (and re-confirm) the existing ones.` },
      }, ["fact"]),
      execute: async (args, context) => {
        const fact = String(args.fact ?? "").trim()
        if (!fact) return "No fact provided."
        const directory = await host.directoryFor(context.sessionID)
        let updated = 0
        let resolvedConflict = false
        let anchorError: string | undefined
        if (args.anchors !== undefined && !Array.isArray(args.anchors)) return anchorsShapeError()
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
          const visible = readableEntries(fresh, directory)
          const target = args.id
            ? visible.find((entry) => entry.id === args.id)
            : args.match
              ? findSimilar(visible, String(args.match))
              : undefined
          if (target) {
            let anchors: Anchor[] | undefined
            if (Array.isArray(args.anchors) && args.anchors.length > 0) {
              if (target.scope !== "project" || !directory) {
                anchorError = "Anchors are only allowed on project-scoped facts; this entry is not project-scoped. Nothing was saved."
                return
              }
              try {
                anchors = await createAnchors(args.anchors, directory, now(), anchorCache)
              } catch (error) {
                anchorError = anchorMessage(error)
                return
              }
            }
            target.text = fact
            target.weight = Math.min(4, target.weight + 0.5)
            target.lastSeen = now()
            if (target.status === "CONFLICTED") {
              target.status = "ACTIVE"
              target.conflictEvidence = undefined
              target.conflictAt = undefined
              resolvedConflict = true
            }
            if (anchors) target.anchors = anchors
            else if (Array.isArray(args.anchors) && target.scope === "project") target.anchors = undefined
            else if (target.anchors?.length) target.anchors = await refreshAnchors(target.anchors, target.projectID, now(), anchorCache)
            updated = 1
          }
          fresh.updatedAt = now()
          await storeIO.writeStore(fresh)
        })
        if (anchorError) return anchorError
        return updated ? `Updated: ${fact}${resolvedConflict ? " (conflict resolved)" : ""}` : "No matching entry found."
      },
    },
    {
      name: "memory_why",
      description: "Explain a memory's provenance, lifecycle status and current score breakdown.",
      input: objectSchema({ id: { type: "string", description: "Entry id from memory_read" } }, ["id"]),
      execute: async (args, context) => {
        const store = await storeIO.getStore()
        const directory = await host.directoryFor(context.sessionID)
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
        for (const [sessionID, ranked] of surface.lastSurface) {
          const hit = ranked.find((candidate) => candidate.entry.id === entry.id)
          if (!hit) continue
          lines.push(`Last surfacing (session ${sessionID}):`)
          lines.push(`  Base score: ${hit.base.toFixed(2)}`)
          lines.push(`  Keyword match: ${hit.keywordHits > 0 ? `+${hit.keywordHits * KEYWORD_BONUS} (${hit.keywordHits} hits)` : "+0"}`)
          lines.push(`  Core slot: ${hit.core ? "yes" : "no"}`)
          lines.push(`  Final rank: #${hit.rank}`)
        }
        lines.push(`Sensitivity: ${entry.sensitivity ?? "normal"}`)
        if (entry.anchors?.length) {
          const anchorState = await entryAnchorState(entry, anchorCache)
          lines.push("Anchors:")
          for (const check of anchorState.checks) {
            lines.push(`  ${anchorLabel(check.anchor)} — ${check.state}${check.state === "fresh" ? "" : ` (${check.reason})`}, anchored ${new Date(check.anchor.anchoredAt).toISOString()}`)
          }
        }
        return lines.join("\n")
      },
    },
    {
      name: "memory_inspect",
      description: "Inspect visible memory statistics, recent facts, conflicts, project facts, or the current session's surfacing breakdown, or memories with stale code anchors.",
      input: objectSchema({
        show: { type: "string", enum: ["stats", "recent", "conflicts", "project", "surfaced", "stale"], description: "View to show (default stats); stale lists code-anchored memories whose code changed (drifted) or disappeared (broken)" },
        limit: { type: "number", description: "Maximum entries in list views (default 10)" },
      }),
      execute: async (args, context) => {
        const store = await storeIO.getStore()
        const directory = await host.directoryFor(context.sessionID)
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
          const summaryChars = config.summary ? store.summary.length : 0
          output.push(`Summary: ${config.summary ? `${summaryChars} chars` : "disabled"}   Avg fact: ${avgChars} chars   Est. full context cost: ${Math.round((summaryChars + visible.reduce((sum, entry) => sum + entry.text.length, 0)) / 4)} tokens`)
          output.push(`Surfaced in last prompts: ${[...surface.lastSurface.values()].reduce((sum, ranked) => sum + ranked.length, 0)}/${visible.length}`)
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
        } else if (show === "stale") {
          const stale: { entry: Entry; state: string; reasons: string[] }[] = []
          for (const entry of visible) {
            if (!entry.anchors?.length) continue
            const anchorState = await entryAnchorState(entry, anchorCache)
            if (anchorState.state === "fresh") continue
            stale.push({ entry, state: anchorState.state, reasons: anchorState.checks.filter((check) => check.state !== "fresh").map(describeCheck) })
          }
          if (stale.length === 0) output.push("No stale code anchors.")
          else {
            output.push(`${stale.length} memor${stale.length === 1 ? "y" : "ies"} with stale code anchors (re-confirm with memory_useful or memory_update, or memory_forget):`)
            for (const item of stale.slice(0, limit)) {
              output.push(`- [${item.entry.id}] (${item.state}) ${item.entry.text}`)
              output.push(`  ${item.reasons.join("; ")}`)
            }
          }
        } else if (show === "surfaced") {
          const ranked = surface.lastSurface.get(context.sessionID)
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
        const directory = await host.directoryFor(context.sessionID)
        let ok = false
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
          if (!readableEntries(fresh, directory).some((entry) => entry.id === args.id)) return
          ok = applyUsefulFeedback(fresh, String(args.id), now())
          if (ok) {
            const entry = fresh.entries.find((candidate) => candidate.id === args.id)
            if (entry?.anchors?.length) entry.anchors = await refreshAnchors(entry.anchors, entry.projectID, now(), anchorCache)
            fresh.updatedAt = now()
            await storeIO.writeStore(fresh)
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
        const directory = await host.directoryFor(context.sessionID)
        let ok = false
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
          if (!readableEntries(fresh, directory).some((entry) => entry.id === args.id)) return
          ok = applyIrrelevantFeedback(fresh, String(args.id), now())
          if (ok) {
            fresh.updatedAt = now()
            await storeIO.writeStore(fresh)
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
        const directory = await host.directoryFor(context.sessionID)
        let removed = 0
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
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
          await storeIO.writeStore(fresh)
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
        const directory = await host.directoryFor(context.sessionID)
        let removed = 0
        await storeIO.withLock(async () => {
          const fresh = await storeIO.getStore()
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
          await storeIO.writeStore(fresh)
        })
        if (args.summaryOnly) return "Cleared memory summary; retained all facts."
        return removed ? `Cleared ${removed} memory entr${removed === 1 ? "y" : "ies"}.` : "Memory already empty."
      },
    },
  ]
}
