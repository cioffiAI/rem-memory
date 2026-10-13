import { describe, expect, test } from "bun:test"
import {
  addEntry,
  applyConsolidation,
  coreSlot,
  emptyStore,
  normalizeStore,
  prune,
  retrieve,
  score,
} from "../src/core.ts"

const DAY = 24 * 60 * 60 * 1000

function entry(overrides: Partial<Parameters<typeof score>[0]> = {}) {
  return {
    id: "e1",
    text: "The user likes coffee.",
    category: "preferences",
    scope: "global" as const,
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "explicit" as const,
    tier: "core" as const,
    status: "ACTIVE" as const,
    sensitivity: "normal" as const,
    ...overrides,
  }
}

describe("normalizeStore", () => {
  test("migrates legacy 'general' category to 'other'", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "general" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("other")
  })

  test("falls back to 'other' for unknown categories", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "not-a-category" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("other")
  })

  test("keeps valid categories untouched", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "workflow" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("workflow")
  })

  test("rejects unsupported store versions", () => {
    const store = { ...emptyStore(), version: 99 } as never
    expect(normalizeStore(store)).toEqual(emptyStore())
  })
})

describe("v1 → v2 migration", () => {
  test("upgrades store version and fills tier/status/sensitivity defaults", () => {
    const v1 = {
      version: 1,
      summary: "",
      updatedAt: 0,
      entries: [
        { ...entry(), tier: undefined, status: undefined, sensitivity: undefined },
        { ...entry({ id: "e2", category: "status", tier: undefined }) },
      ],
    } as never
    const out = normalizeStore(v1)
    expect(out.version).toBe(3)
    expect(out.entries[0].tier).toBe("core") // preferences
    expect(out.entries[0].status).toBe("ACTIVE")
    expect(out.entries[0].sensitivity).toBe("normal")
  })

  test("non-core legacy categories become archival", () => {
    const v1 = { version: 1, summary: "", updatedAt: 0, entries: [{ ...entry({ category: "status", tier: undefined }) }] } as never
    expect(normalizeStore(v1).entries[0].tier).toBe("archival")
  })
})

describe("addEntry", () => {
  test("assigns id and created timestamp", () => {
    const store = emptyStore()
    addEntry(store, {
      text: "The user prefers TypeScript.",
      category: "preferences",
      scope: "global",
      weight: 1,
      lastSeen: 0,
      source: "dreamed",
    })
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].id).toBeTruthy()
    expect(store.entries[0].created).toBeGreaterThan(0)
  })
})

describe("score", () => {
  test("explicit entries rank above dreamed with same weight", () => {
    const t = Date.now()
    const dreamed = score(entry({ source: "dreamed", weight: 3 }), t)
    const explicit = score(entry({ source: "explicit", weight: 3 }), t)
    expect(explicit).toBeGreaterThan(dreamed)
  })

  test("fresh entries rank above old ones (recency decay)", () => {
    const t = Date.now()
    const fresh = score(entry({ lastSeen: t }), t)
    const old = score(entry({ lastSeen: t - 90 * DAY }), t)
    expect(fresh).toBeGreaterThan(old)
  })

  test("pinned entries never decay", () => {
    const t = Date.now()
    const pinned = score(entry({ pinned: true, lastSeen: t - 10 * 365 * DAY }), t)
    expect(pinned).toBeCloseTo(entry({ pinned: true }).weight + 0.5)
  })

  test("helpful feedback boosts, irrelevant feedback lowers", () => {
    const t = Date.now()
    const helpful = score(entry({ helpfulCount: 3 }), t)
    const neutral = score(entry({}), t)
    const irrelevant = score(entry({ irrelevantCount: 3 }), t)
    expect(helpful).toBeGreaterThan(neutral)
    expect(irrelevant).toBeLessThan(neutral)
  })
})

describe("prune", () => {
  test("removes entries whose score decays below the floor", () => {
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "fresh", lastSeen: t }) },
      { ...entry({ id: "stale", weight: 0.5, lastSeen: t - 400 * DAY, source: "dreamed" }) },
    ]
    prune(store, t)
    const ids = store.entries.map((e) => e.id)
    expect(ids).toContain("fresh")
    expect(ids).not.toContain("stale")
  })

  test("never mutates weight (decay lives in score only)", () => {
    const t = Date.now()
    const store = emptyStore()
    const e = { ...entry({ id: "keep", lastSeen: t - 3 * DAY, weight: 1, source: "dreamed" }) }
    store.entries = [e]
    prune(store, t)
    prune(store, t + 7 * DAY)
    prune(store, t + 14 * DAY)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].weight).toBe(1)
  })

  test("decay depends on time, not on how often prune runs", () => {
    const t = Date.now()
    const a = emptyStore()
    const b = emptyStore()
    const e = { ...entry({ id: "x", lastSeen: t - 3 * DAY, weight: 1, source: "dreamed" }) }
    a.entries = [e]
    b.entries = [{ ...e }]
    prune(a, t)
    for (let i = 1; i <= 20; i++) prune(b, t + i * DAY)
    expect(a.entries.map((x) => x.id)).toEqual(b.entries.map((x) => x.id))
    expect(a.entries[0].weight).toBe(b.entries[0].weight)
    expect(a.entries[0].weight).toBe(1)
  })

  test("expired temporary entries are removed", () => {
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "tmp", tier: "temporary", expiresAt: t - 1 }) },
      { ...entry({ id: "ok", tier: "temporary", expiresAt: t + DAY }) },
    ]
    prune(store, t)
    expect(store.entries.map((e) => e.id)).toEqual(["ok"])
  })

  test("superseded tombstones survive the grace period, then are pruned", () => {
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "dead", status: "SUPERSEDED", supersededAt: t - 40 * DAY, source: "dreamed" }) },
      { ...entry({ id: "fresh", status: "SUPERSEDED", supersededAt: t - 1 * DAY, source: "dreamed" }) },
    ]
    prune(store, t)
    expect(store.entries.map((e) => e.id)).toEqual(["fresh"])
  })
})

describe("applyConsolidation", () => {
  test("records provenance on dreamed facts", () => {
    const store = emptyStore()
    applyConsolidation(
      store,
      { new: [{ text: "The user uses Bun.", category: "preferences", scope: "global", confidence: 0.9 }] },
      undefined,
      Date.now(),
      undefined,
      { sessionID: "s1", messageIDs: ["m1", "m2"] },
    )
    const e = store.entries[0]
    expect(e.source).toBe("dreamed")
    expect(e.createdBy).toBe("consolidation")
    expect(e.sourceSessionID).toBe("s1")
    expect(e.sourceMessageIDs).toEqual(["m1", "m2"])
    expect(e.confidence).toBe(0.9)
  })

  test("marks explicit entries CONFLICTED without modifying them", () => {
    const store = emptyStore()
    store.entries = [{ ...entry({ id: "npm", text: "The user always uses npm." }) }]
    const original = { ...store.entries[0] }
    applyConsolidation(store, { conflicts: [{ id: "npm", evidence: "the user now wants Bun everywhere" }] }, undefined)
    expect(store.entries[0].status).toBe("CONFLICTED")
    expect(store.entries[0].conflictEvidence).toContain("Bun")
    expect(store.entries[0].text).toBe(original.text)
    expect(store.entries[0].weight).toBe(original.weight)
  })

  test("dreamed entries in the delete list become SUPERSEDED, explicit survive", () => {
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "dreamed1", source: "dreamed" }) },
      { ...entry({ id: "explicit1", source: "explicit" }) },
    ]
    applyConsolidation(store, { delete: ["dreamed1", "explicit1"] }, undefined)
    expect(store.entries.find((e) => e.id === "dreamed1")?.status).toBe("SUPERSEDED")
    expect(store.entries.find((e) => e.id === "explicit1")).toBeDefined()
    expect(store.entries.find((e) => e.id === "explicit1")?.status).toBe("ACTIVE")
  })
})

describe("retrieve", () => {
  test("ranks keyword matches above unrelated memories and breaks down the score", () => {
    // v1.6: opinion verbs ("preferred") are stopwords; the bridge is the
    // domain noun via translation (colore -> color).
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "geo", text: "The user's favorite color is green.", category: "preferences", weight: 1, source: "dreamed" }) },
      { ...entry({ id: "db", text: "The user maintains a PostgreSQL database.", category: "status", weight: 1, source: "dreamed" }) },
    ]
    const res = retrieve(store, undefined, "quale colore è preferito?", t)
    const top = res[0]
    expect(top.entry.id).toBe("geo")
    expect(top.keywordHits).toBeGreaterThan(0)
    expect(top.matches.every((m) => ["exact", "inflection", "category"].includes(m.kind))).toBe(true)
    expect(top.final).toBe(top.base + top.keywordHits * 3)
    expect(top.rank).toBe(1)
  })

  test("isolates project-scoped memories by directory", () => {
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "p", scope: "project", projectID: "/a" }) },
      { ...entry({ id: "g", scope: "global" }) },
    ]
    expect(retrieve(store, "/a", "anything").map((r) => r.entry.id).sort()).toEqual(["g", "p"])
    expect(retrieve(store, "/b", "anything").map((r) => r.entry.id)).toEqual(["g"])
  })

  test("excludes local-only memories when asked", () => {
    const store = emptyStore()
    store.entries = [{ ...entry({ sensitivity: "local-only" }) }]
    expect(retrieve(store, undefined, "coffee", Date.now(), { excludeSensitivity: new Set(["local-only"]) })).toHaveLength(0)
  })
})

describe("coreSlot", () => {
  test("fills with core-tier memories not already surfaced, newest first", () => {
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "c1", tier: "core", created: t - 2 * DAY }) },
      { ...entry({ id: "c2", tier: "core", created: t }) },
      { ...entry({ id: "a", tier: "archival" }) },
    ]
    const picked = coreSlot(store, undefined, new Set(["c1"]), t, 3).map((e) => e.id)
    expect(picked).toEqual(["c2"])
  })
})
