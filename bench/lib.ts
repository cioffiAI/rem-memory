// Pure evaluation harness for the retrieval benchmark (no CLI output).
//
// Methodology — every metric corresponds to an independently meaningful
// property, and negative scenarios can genuinely fail:
//
//   Candidate quality (independent of the surfacing gate):
//     Recall@K   — share of expected memories present in the top-K of the
//                  full ranking, before any keyword gating.
//     MRR        — reciprocal rank of the first expected memory.
//
//   SURFACE quality (the actual injected block):
//     Surface precision — share of RELEVANCE-TIER surfaced entries that are
//                  expected. Core-slot entries are excluded from both sides:
//                  the product contract surfaces core memories
//                  unconditionally, so they can be neither credited as hits
//                  nor counted as false positives.
//
//   False positives / abstention (negative scenarios, expected = []):
//     FP rate    — share of negative queries where at least one relevance-tier
//                  entry was surfaced. This is falsifiable: a hard negative
//                  sharing lexical material with an irrelevant memory fails.
//     Abstention — 1 − FP rate: negative queries where the relevance tier
//                  stayed empty.
//
//   Context overhead — mean tokens (chars/4) of the full simulated block.

import { coreSlot, CORE_CATEGORIES, passesRelevanceGate, retrieve, type Entry, type RankedMemory, type Store } from "../src/core.ts"
import { NEGATIVE_TAGS, SCENARIOS, type Scenario } from "./scenarios.ts"

export const K = 5
export const SURFACE = 8

export { SCENARIOS, NEGATIVE_TAGS }
export type { Scenario }

const DAY = 24 * 60 * 60 * 1000
const t = Date.now()

export function buildStore(memories: Scenario["memories"]): Store {
  const store: Store = { version: 3, summary: "", updatedAt: t, entries: [], handoffs: [] }
  memories.forEach((m, i) => {
    const tierEntry = (CORE_CATEGORIES.has(m.category ?? "other") ? "core" : "archival") as Entry["tier"]
    const lastSeen = t - (m.lastSeenAgoDays ?? 0) * DAY
    store.entries.push({
      id: `m${i}`,
      text: m.text,
      category: m.category ?? "other",
      scope: m.scope ?? "global",
      projectID: m.scope === "project" ? m.projectID : undefined,
      weight: m.weight ?? 2,
      created: lastSeen,
      lastSeen,
      source: "dreamed",
      tier: tierEntry,
      status: m.status ?? "ACTIVE",
      sensitivity: "normal",
      pinned: m.pinned,
      helpfulCount: m.helpful,
      irrelevantCount: m.irrelevant,
    })
  })
  return store
}

export type ScenarioResult = {
  id: string
  tags: string[]
  expected: number[]
  /** indices of expected memories found in the top-K of the full ranking */
  retrieved: number[]
  /** 1-based rank of the first expected memory in the FULL ranking; 0 if absent */
  rankFirst: number
  /** relevance-tier surface: indices actually surfaced through relevance */
  qualifiedSurfaced: number[]
  /** core-slot indices (contractually always-on; not scored) */
  coreSurfaced: number[]
  /** relevance-tier surfaced indices that are NOT expected */
  falseSurfaced: number[]
  chars: number
  /** per-scenario store for taxonomy/explanation tooling */
  _scenario?: Scenario
}

export function isNegative(scenario: Scenario): boolean {
  return scenario.expected.length === 0 || scenario.tags.some((tag) => NEGATIVE_TAGS.has(tag))
}

export function runScenario(scenario: Scenario): ScenarioResult {
  const store = buildStore(scenario.memories)
  const ranked = retrieve(store, scenario.directory, scenario.query, t, { candidateCount: 30 })

  const top = ranked.slice(0, K)
  const retrieved = [...new Set(top.filter((r) => scenario.expected.includes(Number(r.entry.id.slice(1)))).map((r) => Number(r.entry.id.slice(1))))]

  // rank of the first expected hit within the FULL candidate ranking
  let rankFirst = 0
  for (let i = 0; i < ranked.length && rankFirst === 0; i++) {
    if (scenario.expected.includes(Number(ranked[i].entry.id.slice(1)))) rankFirst = i + 1
  }

  // Surfacing simulation mirroring buildMemoryBlock: the shared lexical
  // relevance gate (passesRelevanceGate) decides what enters the relevance
  // tier; the core slot fills up to its budget with contractually always-on
  // memories.
  const qualified = ranked.filter(passesRelevanceGate).slice(0, SURFACE)
  const qualifiedIds = new Set(qualified.map((r) => r.entry.id))
  const core = coreSlot(store, scenario.directory, qualifiedIds, t, 3)
  // Surfaced literals for overhead accounting; matches are irrelevant here.
  const surfacedForChars: RankedMemory[] = [
    ...qualified,
    ...core.map((e) => ({ entry: e, base: 0, keywordHits: 0, matches: [], core: true, rank: 0, final: 0 })),
  ]

  const idx = (e: Entry) => Number(e.id.slice(1))
  const qualifiedSurfaced = qualified.map((r) => idx(r.entry))
  const coreSurfaced = core.map(idx)
  const falseSurfaced = qualifiedSurfaced.filter((i) => !scenario.expected.includes(i))
  const chars = surfacedForChars.reduce((a, r) => a + r.entry.text.length, 0)

  return {
    id: scenario.id,
    tags: scenario.tags,
    expected: scenario.expected,
    retrieved,
    rankFirst,
    qualifiedSurfaced,
    coreSurfaced,
    falseSurfaced,
    chars,
    _scenario: scenario,
  }
}

// Machine-readable taxonomy entry for one surfaced memory.
export type SurfacedExplanation = {
  scenarioId: string
  tags: string[]
  query: string
  directory?: string
  memoryIndex: number
  text: string
  category: string
  scope: string
  projectID?: string
  tier: string
  status: string
  pinned: boolean
  base: number
  keywordHits: number
  final: number
  surfaceRank: number
  matches: import("../src/core.ts").KeywordMatch[]
  gatePassed: boolean
  gateReason: string
  viaCoreSlot: boolean
  isFalsePositive: boolean
}

// Full explanation of every surfaced memory of a scenario (relevance tier AND
// core slot), with the exact rule that put each item into the block.
export function explainScenario(scenario: Scenario): SurfacedExplanation[] {
  const result = runScenario(scenario)
  const store = buildStore(scenario.memories)
  const ranked = retrieve(store, scenario.directory, scenario.query, t, { candidateCount: 30 })
  const byIdx = new Map(ranked.map((r) => [Number(r.entry.id.slice(1)), r]))
  const out: SurfacedExplanation[] = []
  result.qualifiedSurfaced.forEach((memIdx, i) => {
    const r = byIdx.get(memIdx)
    if (!r) return
    out.push({
      scenarioId: scenario.id,
      tags: scenario.tags,
      query: scenario.query,
      directory: scenario.directory,
      memoryIndex: memIdx,
      text: r.entry.text,
      category: r.entry.category,
      scope: r.entry.scope,
      projectID: r.entry.projectID,
      tier: r.entry.tier ?? "archival",
      status: r.entry.status ?? "ACTIVE",
      pinned: !!r.entry.pinned,
      base: round2(r.base),
      keywordHits: r.keywordHits,
      final: round2(r.final),
      surfaceRank: i + 1,
      matches: r.matches,
      gatePassed: true,
      gateReason: `relevance tier: ${r.keywordHits} keyword match(es) [${r.matches
        .map((m) => `${m.keyword}:${m.kind}${m.via ? ` via '${m.via}'` : ""}`)
        .join(", ")}]`,
      viaCoreSlot: false,
      isFalsePositive: !scenario.expected.includes(memIdx),
    })
  })
  result.coreSurfaced.forEach((memIdx, i) => {
    const mem = scenario.memories[memIdx]
    out.push({
      scenarioId: scenario.id,
      tags: scenario.tags,
      query: scenario.query,
      directory: scenario.directory,
      memoryIndex: memIdx,
      text: mem.text,
      category: mem.category ?? "other",
      scope: mem.scope ?? "global",
      projectID: mem.projectID,
      tier: CORE_CATEGORIES.has(mem.category ?? "other") ? "core" : "archival",
      status: mem.status ?? "ACTIVE",
      pinned: !!mem.pinned,
      base: 0,
      keywordHits: 0,
      final: 0,
      surfaceRank: result.qualifiedSurfaced.length + i + 1,
      matches: [],
      gatePassed: false,
      gateReason: "core slot: contractually always-on (tier core, not already surfaced)",
      viaCoreSlot: true,
      isFalsePositive: false,
    })
  })
  return out
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

export type Metrics = {
  scenarios: number
  positives: number
  negatives: number
  /** share of positives whose FIRST ranked candidate is expected */
  recallAt1: number
  recallAt5: number
  mrr: number
  /** macro: mean of per-scenario surfaced precision (comparable to v1.5.1) */
  surfacePrecisionMacro: number
  /** micro: pooled entries — expected surfaced / all relevance-tier surfaced */
  surfacePrecisionMicro: number
  surfacePrecisionNumer: number
  surfacePrecisionDenom: number
  /** positive scenarios where the relevance tier surfaced NONE of the expected */
  falseAbstentionRate: number
  falseAbstentionScenarios: string[]
  falsePositiveRate: number
  falsePositiveScenarios: string[]
  abstentionRate: number
  /** total irrelevant relevance-tier entries across all negative queries */
  memoryLevelFalsePositives: number
  meanFalseHitsPerNegativeQuery: number
  avgRelevanceTierPerQuery: number
  avgSurfacedPerQuery: number
  overheadTokens: number
  /** negative-query outcome breakdown */
  negativesAbstained: number
  negativesCoreOnlySurfaced: number
  negativesNonCoreSurfaced: number
  /** Wilson 95% score intervals for the headline proportions */
  confidence: {
    recallAt5: Interval
    surfacePrecisionMicro: Interval
    falsePositiveRate: Interval
    abstentionRate: Interval
  }
}

export type Interval = { lo: number; hi: number }

// Wilson score interval (95%): honest uncertainty for small-sample proportions.
export function wilson95(successes: number, n: number): Interval {
  if (n === 0) return { lo: 0, hi: 0 }
  const z = 1.959963984540054
  const p = successes / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function computeMetrics(results: ScenarioResult[]): Metrics {
  const positives = results.filter((r) => r.expected.length > 0)
  const negatives = results.filter((r) => r.expected.length === 0)

  const recallAt5 = mean(positives.map((r) => r.retrieved.length / Math.max(1, r.expected.length)))
  // Recall@1: first ranked candidate is an expected one.
  const recallAt1Hits = results.filter(
    (r) => r.expected.length > 0 && r.retrieved.length > 0 && Number(r.retrieved[0]) === Number(r.expected[0]),
  ).length
  const mrr = mean(positives.map((r) => (r.rankFirst > 0 ? 1 / r.rankFirst : 0)))
  // Surface precision over positives: relevance-tier entries that were
  // expected. A positive whose relevance tier is empty counts as 0 (miss).
  const spNumer = positives.reduce((a, r) => a + r.qualifiedSurfaced.filter((i) => r.expected.includes(i)).length, 0)
  const spDenom = positives.reduce((a, r) => a + r.qualifiedSurfaced.length, 0)
  // Two views (see Metrics): macro per-scenario mean (v1.5.1 comparable) and
  // micro pooled entry-level share carrying the Wilson interval.
  const surfacePrecisionMacro =
    positives.length === 0
      ? 0
      : mean(
          positives.map((r) => {
            const good = r.qualifiedSurfaced.filter((i) => r.expected.includes(i)).length
            return good / Math.max(1, r.qualifiedSurfaced.length)
          }),
        )
  const surfacePrecisionMicro = spDenom === 0 ? 0 : spNumer / spDenom

  // False abstention on positives: gate found nothing for an expected memory.
  const falseAbstentions = positives.filter((r) => !r.qualifiedSurfaced.some((i) => r.expected.includes(i)))

  const fpScenarios = negatives.filter((r) => r.falseSurfaced.length > 0)
  const falsePositiveRate = negatives.length === 0 ? 0 : fpScenarios.length / negatives.length
  const totalFalseHits = negatives.reduce((a, r) => a + r.falseSurfaced.length, 0)
  const coreOnlyNegatives = negatives.filter((r) => r.falseSurfaced.length === 0 && r.coreSurfaced.length > 0)
  const cleanNegatives = negatives.filter((r) => r.falseSurfaced.length === 0 && r.coreSurfaced.length === 0)

  return {
    scenarios: results.length,
    positives: positives.length,
    negatives: negatives.length,
    recallAt1: positives.length === 0 ? 0 : recallAt1Hits / positives.length,
    recallAt5,
    mrr,
    surfacePrecisionMacro,
    surfacePrecisionMicro,
    surfacePrecisionNumer: spNumer,
    surfacePrecisionDenom: spDenom,
    falseAbstentionRate: positives.length === 0 ? 0 : falseAbstentions.length / positives.length,
    falseAbstentionScenarios: falseAbstentions.map((r) => r.id),
    falsePositiveRate,
    falsePositiveScenarios: fpScenarios.map((r) => r.id),
    abstentionRate: 1 - falsePositiveRate,
    memoryLevelFalsePositives: totalFalseHits,
    meanFalseHitsPerNegativeQuery: negatives.length === 0 ? 0 : totalFalseHits / negatives.length,
    avgRelevanceTierPerQuery: mean(results.map((r) => r.qualifiedSurfaced.length)),
    avgSurfacedPerQuery: mean(results.map((r) => r.qualifiedSurfaced.length + r.coreSurfaced.length)),
    overheadTokens: mean(results.map((r) => r.chars / 4)),
    negativesAbstained: cleanNegatives.length,
    negativesCoreOnlySurfaced: coreOnlyNegatives.length,
    negativesNonCoreSurfaced: fpScenarios.length,
    confidence: {
      recallAt5: wilson95(positives.filter((r) => r.retrieved.length === r.expected.length).length, positives.length),
      surfacePrecisionMicro: wilson95(spNumer, spDenom),
      falsePositiveRate: wilson95(fpScenarios.length, negatives.length),
      abstentionRate: wilson95(negatives.length - fpScenarios.length, negatives.length),
    },
  }
}

export function recallByTag(results: ScenarioResult[]): Record<string, number> {
  const tags = [...new Set(SCENARIOS.flatMap((s) => s.tags))]
  const out: Record<string, number> = {}
  for (const tag of tags) {
    const group = results.filter((r) => r.tags.includes(tag) && r.expected.length > 0)
    out[tag] = mean(group.map((r) => r.retrieved.length / Math.max(1, r.expected.length)))
  }
  return out
}

export function allResults(): ScenarioResult[] {
  return SCENARIOS.map(runScenario)
}
