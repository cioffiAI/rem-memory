import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.ts"
import { consolidate } from "../src/engine/dream.ts"
import type { EngineDeps, Host, TranscriptMessage } from "../src/engine/host.ts"
import { createSurface } from "../src/engine/surface.ts"
import { createTools } from "../src/engine/tools.ts"
import { createStore } from "../src/store.ts"

let storeDir: string
let project: string
let prompts: string[]
let answer: () => string
let transcript: TranscriptMessage[]
let deps: EngineDeps
let surface: ReturnType<typeof createSurface>
let call: (name: string, args?: Record<string, unknown>) => Promise<string>
let logs: { message: string; extra?: Record<string, unknown> }[]

const STORE_TS = "export function withLock() { return 1 }\nexport const other = 2\n"

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "rem-anchor-store-"))
  project = await realpath(await mkdtemp(join(tmpdir(), "rem-anchor-engine-")))
  await mkdir(join(project, "src"))
  await writeFile(join(project, "src", "store.ts"), STORE_TS)
  await writeFile(join(project, "src", "cli.ts"), "export const main = 1\n")
  prompts = []
  logs = []
  answer = () => JSON.stringify({ new: [], update: [], delete: [], conflicts: [] })
  transcript = [
    { id: "u1", type: "user", text: "Fix the lock.", time: 100 },
    { id: "a1", type: "assistant", text: "Done.\n[tool]", time: 101, tools: [{ name: "edit", input: { path: "src/store.ts" } }] },
  ]
  const host: Host = {
    name: "opencode",
    session: async () => ({ directory: project, title: "Anchors" }),
    directoryFor: async () => project,
    generate: async (prompt) => {
      prompts.push(prompt)
      return answer()
    },
    transcript: async () => transcript,
    lastUserText: async () => "how does withLock serialize store writes?",
    log: (_level, message, extra) => {
      logs.push({ message, extra })
    },
  }
  deps = { host, config: resolveConfig({ dir: storeDir, rerank: false }), store: createStore(storeDir) }
  surface = createSurface(deps)
  const tools = new Map(createTools(deps, surface).map((tool) => [tool.name, tool]))
  call = (name, args = {}) => tools.get(name)!.execute(args, { sessionID: "s1" })
})

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const FACT = "The withLock helper serializes store writes."

async function idOf(text: string) {
  const store = await deps.store.getStore()
  return store.entries.find((entry) => entry.text === text)!.id
}

async function writeAnchored(extra: Record<string, unknown> = {}) {
  const result = await call("memory_write", { fact: FACT, category: "other", scope: "project", anchors: ["src/store.ts#withLock"], ...extra })
  expect(result).toBe(`Remembered (project): ${FACT}`)
  return idOf(FACT)
}

test("memory_write stores anchors for project facts and rejects invalid ones without saving", async () => {
  const id = await writeAnchored()
  const store = await deps.store.getStore()
  const entry = store.entries.find((candidate) => candidate.id === id)!
  expect(entry.anchors).toHaveLength(1)
  expect(entry.anchors![0]).toMatchObject({ path: "src/store.ts", symbol: "withLock" })

  const bad = await call("memory_write", { fact: "Another fact about cli.", scope: "project", anchors: ["src/missing.ts"] })
  expect(bad).toContain("Invalid anchor")
  expect(bad).toContain("Nothing was saved")
  expect(await call("memory_write", { fact: "Another fact about cli.", scope: "project", anchors: ["../outside.ts"] })).toContain("Invalid anchor")
  expect(await call("memory_write", { fact: "Another fact about cli.", scope: "project", anchors: ["src/store.ts#ghost"] })).toContain("not found")
  expect(await call("memory_write", { fact: "Another fact about cli.", scope: "global", anchors: ["src/store.ts"] })).toContain("project-scoped")
  expect(await call("memory_write", { fact: "Another fact about cli.", scope: "project", anchors: ["a", "b", "c", "d"] })).toContain("at most 3")
  expect((await deps.store.getStore()).entries.map((candidate) => candidate.text)).toEqual([FACT])
})

test("a drifted anchor is annotated in the surfaced block; memory_read marks it", async () => {
  const id = await writeAnchored()
  expect(await surface.buildMemoryBlock("s1")).toContain(`${FACT}\n`)
  expect(await surface.buildMemoryBlock("s1")).not.toContain("code changed")

  await writeFile(join(project, "src", "store.ts"), `${STORE_TS}// edited\n`)
  const block = (await surface.buildMemoryBlock("s1"))!
  expect(block).toContain(`${FACT} (code changed since: src/store.ts)`)
  expect(await call("memory_read", {})).toContain(`[${id}]`)
  expect(await call("memory_read", {})).toContain(`${FACT} [drifted]`)
  expect(await call("memory_why", { id })).toContain("src/store.ts#withLock — drifted (file changed)")
})

test("a broken anchor is excluded from the block but visible and marked in memory_read", async () => {
  await writeAnchored()
  await call("memory_write", { fact: "The cli entry point is main.", category: "project", scope: "project", anchors: ["src/cli.ts#main"] })
  await writeFile(join(project, "src", "store.ts"), "export const nothingHere = 0\n")
  await rm(join(project, "src", "cli.ts"))

  const block = (await surface.buildMemoryBlock("s1"))!
  expect(block).not.toContain(FACT)
  expect(block).not.toContain("cli entry point") // core-slot entry obeys the same rule
  const read = await call("memory_read", {})
  expect(read).toContain(`${FACT} [stale: src/store.ts#withLock symbol missing]`)
  expect(read).toContain("[stale: src/cli.ts#main file missing]")

  // coming back to the code makes the memory visible again (state is derived)
  await writeFile(join(project, "src", "store.ts"), STORE_TS)
  expect(await surface.buildMemoryBlock("s1")).toContain(FACT)
})

test("entries without anchors surface exactly as before", async () => {
  await call("memory_write", { fact: "Withlock notes live in the wiki and serialize nothing.", category: "other", scope: "project" })
  const block = (await surface.buildMemoryBlock("s1"))!
  expect(block).toContain("- [explicit] (other) Withlock notes live in the wiki and serialize nothing.\n")
})

test("memory_inspect stale lists drifted and broken with reasons", async () => {
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")
  const id = await writeAnchored()
  await call("memory_write", { fact: "The cli entry point is main.", scope: "project", anchors: ["src/cli.ts"] })
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")

  await writeFile(join(project, "src", "store.ts"), `${STORE_TS}// edited\n`)
  await rm(join(project, "src", "cli.ts"))
  const output = await call("memory_inspect", { show: "stale" })
  expect(output).toContain("2 memories with stale code anchors")
  expect(output).toContain(`[${id}] (drifted) ${FACT}`)
  expect(output).toContain("src/store.ts#withLock file changed")
  expect(output).toContain("(broken) The cli entry point is main.")
  expect(output).toContain("src/cli.ts file missing")
})

test("memory_why lists every anchor with its state", async () => {
  const id = await writeAnchored({ anchors: ["src/store.ts#withLock", "src/cli.ts"] })
  await rm(join(project, "src", "cli.ts"))
  const why = await call("memory_why", { id })
  expect(why).toContain("Anchors:")
  expect(why).toContain("src/store.ts#withLock — fresh")
  expect(why).toContain("src/cli.ts — broken (file missing)")
})

test("memory_useful, memory_update and a repeated memory_write re-anchor to fresh", async () => {
  const id = await writeAnchored()
  const edit = async (suffix: string) => writeFile(join(project, "src", "store.ts"), `${STORE_TS}// ${suffix}\n`)

  await edit("one")
  expect(await call("memory_inspect", { show: "stale" })).toContain("(drifted)")
  expect(await call("memory_useful", { id })).toBe("Noted as useful.")
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")

  await edit("two")
  expect(await call("memory_update", { id, fact: `${FACT} (v2)` })).toContain("Updated")
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")

  await edit("three")
  await call("memory_write", { fact: `${FACT} (v2)`, scope: "project" })
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")
  const store = await deps.store.getStore()
  expect(store.entries).toHaveLength(1)
  expect(store.entries[0].anchors).toHaveLength(1)

  // file removed: re-confirmation keeps the old anchor, which stays stale
  await rm(join(project, "src", "store.ts"))
  await call("memory_useful", { id })
  expect(await call("memory_inspect", { show: "stale" })).toContain("(broken)")
})

test("memory_update replaces, clears and validates anchors", async () => {
  const id = await writeAnchored()
  expect(await call("memory_update", { id, fact: FACT, anchors: ["src/cli.ts#main"] })).toContain("Updated")
  let entry = (await deps.store.getStore()).entries[0]
  expect(entry.anchors!.map((anchor) => anchor.path)).toEqual(["src/cli.ts"])

  const bad = await call("memory_update", { id, fact: "changed", anchors: ["src/nope.ts"] })
  expect(bad).toContain("Invalid anchor")
  entry = (await deps.store.getStore()).entries[0]
  expect(entry.text).toBe(FACT) // not saved

  expect(await call("memory_update", { id, fact: FACT, anchors: [] })).toContain("Updated")
  expect((await deps.store.getStore()).entries[0].anchors).toBeUndefined()

  await call("memory_write", { fact: "A global preference.", scope: "global" })
  const global = await idOf("A global preference.")
  expect(await call("memory_update", { id: global, fact: "A global preference.", anchors: ["src/cli.ts"] })).toContain("project-scoped")
})

test("local-only anchored entries stay invisible everywhere", async () => {
  await call("memory_write", { fact: "Secret local note about withLock.", scope: "project", sensitivity: "local-only", anchors: ["src/store.ts"] })
  await writeFile(join(project, "src", "store.ts"), "changed")
  expect(await call("memory_read", {})).toBe("No memory entries found.")
  expect(await call("memory_inspect", { show: "stale" })).toBe("No stale code anchors.")
  expect(await surface.buildMemoryBlock("s1")).not.toContain("Secret local note")
})

test("DREAM keeps only valid anchors on touched files and drops the rest", async () => {
  answer = () =>
    JSON.stringify({
      new: [
        {
          text: "The withLock helper guards every store mutation.",
          category: "project",
          scope: "project",
          anchors: ["src/store.ts#withLock", "src/cli.ts", "src/missing.ts", "../escape.ts"],
        },
        { text: "The user likes anchors in global scope.", category: "preferences", scope: "global", anchors: ["src/store.ts"] },
      ],
      update: [],
      delete: [],
      conflicts: [],
    })
  await consolidate(deps, "s1")
  const prompt = prompts[0]
  expect(prompt).toContain("CODE ANCHORS:")
  expect(prompt).toContain("  src/store.ts")
  expect(prompt).toContain('"anchors":["path#symbol"]')

  const store = await deps.store.getStore()
  const project_ = store.entries.find((entry) => entry.text.startsWith("The withLock helper"))!
  expect(project_.anchors).toHaveLength(1) // cli.ts was not touched, the others are invalid
  expect(project_.anchors![0]).toMatchObject({ path: "src/store.ts", symbol: "withLock" })
  expect(project_.source).toBe("dreamed")
  expect(store.entries.find((entry) => entry.text.startsWith("The user likes"))!.anchors).toBeUndefined()
  expect(logs.filter((log) => log.message === "dropped invalid anchor").length).toBe(2) // only the first 3 specs are considered
})

test("DREAM without touched files adds nothing anchor-related to the prompt and drops anchors", async () => {
  transcript = [{ id: "u1", type: "user", text: "Just a question.", time: 100 }]
  answer = () =>
    JSON.stringify({ new: [{ text: "The project uses Bun for tests.", category: "project", scope: "project", anchors: ["src/store.ts"] }], update: [], delete: [], conflicts: [] })
  await consolidate(deps, "s1")
  expect(prompts[0]).not.toContain("CODE ANCHORS")
  expect(prompts[0]).not.toContain("BROKEN ANCHORS")
  expect(prompts[0]).not.toContain('"anchors"')
  expect((await deps.store.getStore()).entries[0].anchors).toBeUndefined()
})

test("DREAM prompt tags broken anchors; dreamed entries can be re-anchored, explicit ones are protected", async () => {
  // a dreamed anchored entry and an explicit anchored entry, both broken
  answer = () =>
    JSON.stringify({ new: [{ text: "The cli entry point is main.", category: "project", scope: "project", anchors: ["src/store.ts#withLock"] }], update: [], delete: [], conflicts: [] })
  await consolidate(deps, "s1")
  const dreamedId = await idOf("The cli entry point is main.")
  const explicitId = await writeAnchored()
  await writeFile(join(project, "src", "store.ts"), "export const gone = 1\n")

  prompts.length = 0
  transcript = [
    ...transcript,
    { id: "u2", type: "user", text: "Rewrote store.", time: 200 },
    { id: "a2", type: "assistant", text: "ok", time: 201, tools: [{ name: "edit", input: { path: "src/store.ts" } }] },
  ]
  await writeFile(join(project, "src", "store.ts"), "export function newLock() {}\n")
  answer = () =>
    JSON.stringify({
      new: [],
      update: [
        { id: dreamedId, text: "The cli entry point is main.", anchors: ["src/store.ts#newLock"] },
        { id: explicitId, text: "Hijacked explicit text.", anchors: ["src/store.ts#newLock"] },
      ],
      delete: [explicitId],
      conflicts: [{ id: explicitId, evidence: "withLock was replaced by newLock" }],
    })
  await consolidate(deps, "s1")
  const prompt = prompts[0]
  expect(prompt).toContain("BROKEN ANCHORS:")
  expect(prompt).toContain(`[${dreamedId}]`)
  expect(prompt).toContain("anchor=broken(src/store.ts#withLock symbol missing)")

  const store = await deps.store.getStore()
  const dreamed = store.entries.find((entry) => entry.id === dreamedId)!
  expect(dreamed.anchors![0]).toMatchObject({ path: "src/store.ts", symbol: "newLock" })
  const explicit = store.entries.find((entry) => entry.id === explicitId)!
  expect(explicit.text).toBe(FACT) // never rewritten or deleted
  expect(explicit.anchors![0].symbol).toBe("withLock")
  expect(explicit.status).toBe("CONFLICTED")
})

test("DREAM prompt has no broken-anchor section when everything is fresh", async () => {
  await writeAnchored()
  await consolidate(deps, "s1")
  expect(prompts[0]).not.toContain("BROKEN ANCHORS")
  expect(prompts[0]).not.toContain("anchor=broken")
})
