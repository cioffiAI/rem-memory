// SURFACE: build the <memory> block injected into the model context.
// retrieve -> optional rerank (via the host's model) -> relevance gate ->
// core slot -> render, plus the per-session bookkeeping memory_why and
// memory_inspect read back.

import {
  applyRerankOrderAnswer,
  applySurfaceFeedback,
  coreSlot,
  parseRerankAnswer,
  passesRelevanceGate,
  retrieve,
  score,
  type RankedMemory,
} from "../core.ts"
import type { EngineDeps } from "./host.ts"

type RerankCacheEntry = { at: number; order: string[]; abstain?: boolean }
type SurfaceState = { lastSurface: Map<string, RankedMemory[]>; rerankCache: Map<string, RerankCacheEntry> }

function now() {
  return Date.now()
}

async function rerank(
  { host, config }: EngineDeps,
  cache: Map<string, RerankCacheEntry>,
  sessionID: string,
  query: string,
  candidates: RankedMemory[],
): Promise<RankedMemory[]> {
  if (candidates.length <= 1) return candidates
  const key = query.trim().toLowerCase() || " "
  const cached = cache.get(key)
  if (cached && now() - cached.at < config.rerankCacheMs) {
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
    const answer = await host.generate(prompt, { sessionID, timeoutMs: config.rerankTimeoutMs })
    if (!answer) return candidates
    const outcome = parseRerankAnswer(answer, visible.length)
    if (outcome.kind === "abstain") {
      cache.set(key, { at: now(), order: [], abstain: true })
      return []
    }
    if (outcome.kind === "invalid") return candidates
    const ordered = applyRerankOrderAnswer(visible, outcome)
    const order = ordered.map((candidate) => candidate.entry.id)
    cache.set(key, { at: now(), order })
    const selected = new Set(order)
    return [...ordered, ...candidates.filter((candidate) => !selected.has(candidate.entry.id))]
  } catch (error) {
    host.log("debug", "rerank failed; lexical fallback", { sessionID, error: String(error) })
    return candidates
  }
}

async function markSurfaced({ host, config, store: storeIO }: EngineDeps, ids: string[], time = now()) {
  if (ids.length === 0) return
  try {
    await storeIO.withLock(async () => {
      const store = await storeIO.getStore()
      const due = ids.some((id) => {
        const entry = store.entries.find((candidate) => candidate.id === id)
        return !!entry && time - (entry.lastUsed ?? 0) >= config.surfaceRefreshMs
      })
      if (!due) return
      applySurfaceFeedback(store, ids, time, config.surfaceRefreshMs)
      await storeIO.writeStore(store)
    })
  } catch (error) {
    host.log("debug", "markSurfaced failed", { error: String(error) })
  }
}

async function buildMemoryBlock(
  deps: EngineDeps,
  state: SurfaceState,
  sessionID: string,
): Promise<string | undefined> {
  const { host, config, store: storeIO } = deps
  const store = await storeIO.getStore()
  if (store.entries.length === 0 && !(config.summary && store.summary)) return undefined
  const session = await host.session(sessionID)
  if (!session) return undefined
  const directory = session.directory
  const time = now()
  const query = await host.lastUserText(sessionID)
  const ranked = retrieve(store, directory, query, time, {
    excludeSensitivity: new Set(["local-only"]),
    candidateCount: config.rerankCandidates,
  })
  const reranked = config.rerank ? await rerank(deps, state.rerankCache, sessionID, query, ranked) : ranked
  const qualified = config.rerank ? reranked : reranked.filter(passesRelevanceGate)
  const top = qualified.slice(0, config.maxFacts)
  const selected = new Set(top.map((candidate) => candidate.entry.id))
  const core = coreSlot(store, directory, selected, time, config.coreSlot)
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
  state.lastSurface.set(sessionID, surfaced)
  void markSurfaced(deps, surfaced.map((candidate) => candidate.entry.id), time)

  const lines = [
    "<memory>",
    "The following is long-term memory from previous conversations with this user. Use it to personalize responses and follow established preferences. If something contradicts newer information, trust the newer information.",
  ]
  if (config.summary && store.summary) lines.push(`<summary>${store.summary}</summary>`)
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
  if (block.length > config.maxChars) block = `${block.slice(0, config.maxChars - 1)}…`
  return block
}

export function createSurface(deps: EngineDeps) {
  const state: SurfaceState = { lastSurface: new Map(), rerankCache: new Map() }
  return {
    // What each session was last shown; read by memory_why and memory_inspect.
    lastSurface: state.lastSurface as ReadonlyMap<string, RankedMemory[]>,
    buildMemoryBlock: (sessionID: string) => buildMemoryBlock(deps, state, sessionID),
  }
}

export type Surface = ReturnType<typeof createSurface>
