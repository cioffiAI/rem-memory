import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.ts"
import { consolidate } from "../src/engine/dream.ts"
import { writeMechanicalHandoff } from "../src/engine/handoff.ts"
import type { ChangedFile, EngineDeps, Host, TranscriptMessage } from "../src/engine/host.ts"
import { createSurface } from "../src/engine/surface.ts"
import { createTools } from "../src/engine/tools.ts"
import { createStore } from "../src/store.ts"

type FakeSession = { directory: string; messages: TranscriptMessage[]; lastUser?: string }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function user(id: string, text: string, time: number): TranscriptMessage {
  return { id, type: "user", text, time }
}

function edited(id: string, files: string[], time: number): TranscriptMessage {
  return { id, type: "assistant", text: "Done.", time, snapshotFiles: files }
}

async function setup(options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rem-memory-handoff-"))
  dirs.push(dir)
  const sessions = new Map<string, FakeSession>()
  const vcs = { branch: "main" as string | undefined, changed: [] as ChangedFile[] }
  const answers: string[] = []
  const prompts: string[] = []
  const host: Host = {
    name: "opencode",
    session: async (id) => (sessions.has(id) ? { directory: sessions.get(id)!.directory, title: "T" } : undefined),
    directoryFor: async (id) => sessions.get(id)?.directory,
    generate: async (prompt) => {
      prompts.push(prompt)
      return answers.shift() ?? JSON.stringify({ new: [], update: [], delete: [], conflicts: [] })
    },
    transcript: async (id) => sessions.get(id)?.messages ?? [],
    lastUserText: async (id) => sessions.get(id)?.lastUser ?? [...(sessions.get(id)?.messages ?? [])].reverse().find((m) => m.type === "user")?.text ?? "",
    vcs: async () => ({ branch: vcs.branch, changed: vcs.changed }),
    log: () => {},
  }
  const config = resolveConfig({ dir, rerank: false, ...options }, {})
  const store = createStore(dir)
  const deps: EngineDeps = { host, config, store }
  const surface = createSurface(deps)
  const tools = new Map(createTools(deps, surface).map((tool) => [tool.name, tool]))
  const call = (name: string, sessionID: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args, { sessionID })
  const session = (id: string, directory: string, messages: TranscriptMessage[]) => {
    sessions.set(id, { directory, messages })
  }
  return { dir, deps, store, surface, call, session, vcs, answers, prompts, sessions }
}

// A finished session in /proj that edited src/a.ts.
function codingSession(t: Awaited<ReturnType<typeof setup>>, id: string, directory = "/proj", request = "Refactor the parser") {
  t.session(id, directory, [user(`${id}-u`, request, 100), edited(`${id}-a`, ["src/a.ts"], 101)])
}

function nextSession(t: Awaited<ReturnType<typeof setup>>, id: string, directory = "/proj") {
  t.session(id, directory, [user(`${id}-u`, "continue please", 200)])
}

test("completion writes a mechanical handoff without DREAM", async () => {
  const t = await setup()
  codingSession(t, "s1")
  t.vcs.changed = [{ file: "src/a.ts", status: "added" }]
  await writeMechanicalHandoff(t.deps, "s1")
  const { handoffs } = await t.store.getStore()
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0]).toMatchObject({
    projectID: "/proj", sessionID: "s1", level: "mechanical", branch: "main",
    request: "Refactor the parser", files: [{ path: "src/a.ts", status: "added" }], origin: { host: "opencode" },
  })
  expect(t.prompts).toHaveLength(0)
})

test("a file absent from vcs status is reported as modified; no branch without vcs branch", async () => {
  const t = await setup()
  codingSession(t, "s1")
  t.vcs.branch = undefined
  await writeMechanicalHandoff(t.deps, "s1")
  const [handoff] = (await t.store.getStore()).handoffs
  expect(handoff.files).toEqual([{ path: "src/a.ts", status: "modified" }])
  expect(handoff.branch).toBeUndefined()
})

test("in a project below the repository root, snapshot and vcs paths are mapped to the project", async () => {
  const t = await setup()
  const repo = await realpath(await mkdtemp(join(tmpdir(), "rem-handoff-repo-")))
  try {
    await mkdir(join(repo, ".git"))
    await mkdir(join(repo, "app"))
    const project = join(repo, "app")
    t.session("s1", project, [user("s1-u", "Fix it", 100), edited("s1-a", ["app/src/a.ts", "lib/x.ts"], 101)])
    t.vcs.changed = [{ file: "app/src/a.ts", status: "added" }, { file: "lib/x.ts", status: "modified" }]
    await writeMechanicalHandoff(t.deps, "s1")
    const [handoff] = (await t.store.getStore()).handoffs
    expect(handoff.files).toEqual([{ path: "src/a.ts", status: "added" }])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("request is truncated to 300 chars", async () => {
  const t = await setup()
  t.session("s1", "/proj", [user("u", "x".repeat(500), 1), edited("a", ["f.ts"], 2)])
  await writeMechanicalHandoff(t.deps, "s1")
  expect((await t.store.getStore()).handoffs[0].request!.length).toBe(300)
})

test("a trivial session (no files touched) leaves no handoff", async () => {
  const t = await setup()
  t.session("s1", "/proj", [user("u", "what is a monad?", 1), { id: "a", type: "assistant", text: "A monad is...", time: 2 }])
  await writeMechanicalHandoff(t.deps, "s1")
  expect((await t.store.getStore()).handoffs).toHaveLength(0)
})

test("one handoff per session: later completions upsert", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  const first = (await t.store.getStore()).handoffs[0]
  t.session("s1", "/proj", [user("u", "Refactor the parser", 100), edited("a", ["src/a.ts"], 101), user("u2", "also fix b", 102), edited("a2", ["src/b.ts"], 103)])
  await Bun.sleep(5)
  await writeMechanicalHandoff(t.deps, "s1")
  const { handoffs } = await t.store.getStore()
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0].id).toBe(first.id)
  expect(handoffs[0].createdAt).toBe(first.createdAt)
  expect(handoffs[0].updatedAt).toBeGreaterThan(first.updatedAt)
  expect(handoffs[0].files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
  expect(handoffs[0].request).toBe("also fix b")
})

test("retention keeps the newest handoffKeep per project and 50 overall", async () => {
  const t = await setup({ handoffKeep: 2 })
  for (const id of ["a1", "a2", "a3"]) {
    codingSession(t, id, "/projA")
    await writeMechanicalHandoff(t.deps, id)
    await Bun.sleep(3)
  }
  codingSession(t, "b1", "/projB")
  await writeMechanicalHandoff(t.deps, "b1")
  const sessionsKept = (await t.store.getStore()).handoffs.map((handoff) => handoff.sessionID).sort()
  expect(sessionsKept).toEqual(["a2", "a3", "b1"])

  const big = await setup({ handoffKeep: 1 })
  for (let i = 0; i < 55; i++) {
    codingSession(big, `s${i}`, `/p${i}`)
    await writeMechanicalHandoff(big.deps, `s${i}`)
  }
  expect((await big.store.getStore()).handoffs).toHaveLength(50)
})

test("DREAM prompt asks for a handoff only when enabled, other text unchanged", async () => {
  const on = await setup()
  const off = await setup({ handoff: false })
  for (const t of [on, off]) {
    codingSession(t, "s1")
    await consolidate(t.deps, "s1")
  }
  expect(on.prompts[0]).toContain("handoff:")
  expect(on.prompts[0]).toContain("NEVER include secrets")
  expect(on.prompts[0]).toContain('"handoff":{"goal"')
  expect(off.prompts[0]).not.toContain("handoff")
  expect(on.prompts[0].replace(/\n6\. handoff:[^\n]*/, "").replace(',"handoff":{"goal":"...","state":"...","next":["..."],"openQuestions":["..."]}', "")).toBe(off.prompts[0])
})

test("DREAM enrichment merges a narrative into the mechanical handoff, capped", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  t.answers.push(JSON.stringify({
    new: [], update: [], delete: [], conflicts: [],
    handoff: { goal: "g".repeat(400), state: "Parser half done", next: ["a", "b", "c", "d", "e", "f", "x".repeat(300)], openQuestions: ["Which grammar?"] },
  }))
  await consolidate(t.deps, "s1")
  const { handoffs } = await t.store.getStore()
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0].level).toBe("enriched")
  expect(handoffs[0].files).toHaveLength(1)
  expect(handoffs[0].narrative!.goal.length).toBe(300)
  expect(handoffs[0].narrative!.state).toBe("Parser half done")
  expect(handoffs[0].narrative!.next).toEqual(["a", "b", "c", "d", "e"])
  expect(handoffs[0].narrative!.openQuestions).toEqual(["Which grammar?"])
})

test("DREAM can create the enriched handoff when none was written", async () => {
  const t = await setup()
  t.session("s1", "/proj", [user("u", "Design the cache", 1), { id: "a", type: "assistant", text: "Plan...", time: 2 }])
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: { goal: "Design cache", state: "Plan agreed", next: ["Implement"], openQuestions: [] } }))
  await consolidate(t.deps, "s1")
  const [handoff] = (await t.store.getStore()).handoffs
  expect(handoff).toMatchObject({ sessionID: "s1", projectID: "/proj", level: "enriched", files: [] })
})

test("DREAM handoff null removes a handoff with no files, keeps one with files", async () => {
  const t = await setup()
  // an enriched handoff without files exists, then DREAM judges the session trivial
  t.session("s1", "/proj", [user("u", "Design the cache", 1), { id: "a", type: "assistant", text: "Plan...", time: 2 }])
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: { goal: "Design cache", state: "s", next: [], openQuestions: [] } }))
  await consolidate(t.deps, "s1")
  expect((await t.store.getStore()).handoffs).toHaveLength(1)
  t.sessions.get("s1")!.messages.push(user("u2", "thanks", 50))
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: null }))
  await consolidate(t.deps, "s1")
  expect((await t.store.getStore()).handoffs).toHaveLength(0)

  codingSession(t, "s2")
  await writeMechanicalHandoff(t.deps, "s2")
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: null }))
  await consolidate(t.deps, "s2")
  expect((await t.store.getStore()).handoffs).toHaveLength(1)
})

test("handoff=false: DREAM ignores a handoff answer and nothing is written", async () => {
  const t = await setup({ handoff: false })
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: { goal: "g", state: "s", next: [], openQuestions: [] } }))
  await consolidate(t.deps, "s1")
  expect((await t.store.getStore()).handoffs).toHaveLength(0)
})

test("handoff is injected on the first request of a later session, once", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  nextSession(t, "s2")
  const block = await t.surface.buildMemoryBlock("s2")
  expect(block).toContain("<memory>")
  expect(block).toContain("<handoff>")
  expect(block).toContain("Mention it only if the user's request relates to it; do not assume they want to continue.")
  expect(block).toContain("Request: Refactor the parser")
  expect(block).toContain("src/a.ts (modified)")
  expect(block).toContain("</handoff>\n</memory>")
  expect(block).not.toContain("written on branch")
  // not again in the same session, not on later requests of any session
  expect(await t.surface.buildMemoryBlock("s2")).toBeUndefined()
  nextSession(t, "s3")
  t.sessions.get("s3")!.messages.push({ id: "x", type: "assistant", text: "ok", time: 201 }, user("u2", "and then?", 202))
  expect(await t.surface.buildMemoryBlock("s3")).toBeUndefined()
})

test("the session that produced the handoff never receives it", async () => {
  const t = await setup()
  t.session("s1", "/proj", [user("u", "Refactor the parser", 100)])
  t.sessions.get("s1")!.messages.push(edited("a", ["src/a.ts"], 101))
  await writeMechanicalHandoff(t.deps, "s1")
  t.sessions.get("s1")!.messages.splice(0, 2, user("u", "Refactor the parser", 100))
  expect(await t.surface.buildMemoryBlock("s1")).toBeUndefined()
})

test("handoffs expire after handoffMaxAgeHours", async () => {
  const t = await setup({ handoffMaxAgeHours: 1 })
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  await t.store.withLock(async () => {
    const store = await t.store.getStore()
    store.handoffs[0].updatedAt = Date.now() - 2 * 60 * 60 * 1000
    await t.store.writeStore(store)
  })
  nextSession(t, "s2")
  expect(await t.surface.buildMemoryBlock("s2")).toBeUndefined()
  // still listed by the tool
  expect(await t.call("memory_handoff", "s2", { action: "list" })).toContain("Refactor the parser")
})

test("a dismissed handoff is not injected", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  nextSession(t, "s2")
  expect(await t.call("memory_handoff", "s2", { action: "dismiss" })).toContain("Dismissed handoff")
  expect(await t.surface.buildMemoryBlock("s2")).toBeUndefined()
  expect(await t.call("memory_handoff", "s2", { action: "list" })).toContain("dismissed")
  expect(await t.call("memory_handoff", "s2", { action: "dismiss" })).toBe("No matching handoff found.")
})

test("a branch note appears when the current branch differs", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  t.vcs.branch = "feature/x"
  nextSession(t, "s2")
  expect(await t.surface.buildMemoryBlock("s2")).toContain("(written on branch main)")
})

test("handoff of project A is invisible in project B (injection and tools)", async () => {
  const t = await setup()
  codingSession(t, "a1", "/projA")
  await writeMechanicalHandoff(t.deps, "a1")
  nextSession(t, "b1", "/projB")
  expect(await t.surface.buildMemoryBlock("b1")).toBeUndefined()
  expect(await t.call("memory_handoff", "b1", { action: "show" })).toBe("No handoff for this project.")
  expect(await t.call("memory_handoff", "b1", { action: "list" })).toBe("No handoff for this project.")
  const id = (await t.store.getStore()).handoffs[0].id
  expect(await t.call("memory_handoff", "b1", { action: "dismiss", id })).toBe("No matching handoff found.")
  expect((await t.store.getStore()).handoffs[0].dismissedAt).toBeUndefined()
  // a project that merely shares a prefix is a different project
  nextSession(t, "c1", "/projA/sub")
  expect(await t.surface.buildMemoryBlock("c1")).toBeUndefined()
})

test("the handoff is emitted even when the memory store is empty, and is not injected when handoff=false", async () => {
  const t = await setup()
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  nextSession(t, "s2")
  const block = (await t.surface.buildMemoryBlock("s2"))!
  expect(block.startsWith("<memory>\n<handoff>")).toBe(true)

  const off = await setup({ handoff: false })
  codingSession(off, "s1")
  await writeMechanicalHandoff(off.deps, "s1")
  nextSession(off, "s2")
  // tool still works on existing data
  await off.store.withLock(async () => {
    const store = await off.store.getStore()
    store.handoffs.push({ id: "h1", projectID: "/proj", sessionID: "old", origin: { host: "opencode" }, createdAt: 1, updatedAt: Date.now(), files: [], level: "mechanical", request: "legacy request" })
    await off.store.writeStore(store)
  })
  expect(await off.surface.buildMemoryBlock("s2")).toBeUndefined()
  expect(await off.call("memory_handoff", "s2", { action: "show" })).toContain("legacy request")
})

test("handoff and facts together respect maxChars; the handoff respects handoffMaxChars", async () => {
  const t = await setup({ maxChars: 600, handoffMaxChars: 200 })
  await t.call("memory_write", "s2", { fact: "The user prefers tabs over spaces in every project they touch." })
  for (let i = 0; i < 6; i++) await t.call("memory_write", "s2", { fact: `Fact number ${i} about the proj tooling and conventions ${"y".repeat(60)}`, scope: "project" })
  codingSession(t, "s1")
  t.sessions.get("s1")!.messages.push(edited("a2", Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`), 102))
  await writeMechanicalHandoff(t.deps, "s1")
  nextSession(t, "s2")
  const block = (await t.surface.buildMemoryBlock("s2"))!
  expect(block.length).toBeLessThanOrEqual(600)
  const handoff = block.slice(block.indexOf("<handoff>"), block.indexOf("</handoff>") + "</handoff>".length)
  expect(handoff.length).toBeLessThanOrEqual(200)
  expect(handoff.endsWith("</handoff>")).toBe(true)
  expect(block.endsWith("</handoff>\n</memory>")).toBe(true)
})

test("files are listed up to 10 in the injected block, with +N more", async () => {
  const t = await setup()
  t.session("s1", "/proj", [user("u", "big change", 1), edited("a", Array.from({ length: 14 }, (_, i) => `f${i}.ts`), 2)])
  await writeMechanicalHandoff(t.deps, "s1")
  nextSession(t, "s2")
  const block = (await t.surface.buildMemoryBlock("s2"))!
  expect(block).toContain("f9.ts")
  expect(block).not.toContain("f10.ts")
  expect(block).toContain("+4 more")
})

test("injected handoff shows the narrative of an enriched handoff", async () => {
  const t = await setup()
  codingSession(t, "s1")
  t.answers.push(JSON.stringify({ new: [], update: [], delete: [], conflicts: [], handoff: { goal: "Ship the parser", state: "Tokenizer done", next: ["Write grammar"], openQuestions: ["PEG or LR?"] } }))
  await consolidate(t.deps, "s1")
  nextSession(t, "s2")
  const block = (await t.surface.buildMemoryBlock("s2"))!
  for (const text of ["Goal: Ship the parser", "State: Tokenizer done", "- Write grammar", "- PEG or LR?"]) expect(block).toContain(text)
})

test("memory_handoff show/list/dismiss", async () => {
  const t = await setup()
  expect(await t.call("memory_handoff", "s9", { action: "show" })).toBe("No handoff for this project.")
  codingSession(t, "s1")
  await writeMechanicalHandoff(t.deps, "s1")
  await Bun.sleep(3)
  codingSession(t, "s2", "/proj", "Second task")
  await writeMechanicalHandoff(t.deps, "s2")
  t.session("s9", "/proj", [user("u", "hi", 1)])
  expect(await t.call("memory_handoff", "s9", { action: "show" })).toContain("Request: Second task")
  const list = await t.call("memory_handoff", "s9", { action: "list" })
  expect(list).toContain("2 handoffs")
  expect(list).toContain("Refactor the parser")
  expect(await t.call("memory_handoff", "s9", { action: "dismiss", id: (await t.store.getStore()).handoffs.find((h) => h.sessionID === "s1")!.id })).toContain("Dismissed")
  expect(await t.call("memory_handoff", "s9", { action: "bogus" })).toContain("Unknown action")
})

test("memory_clear variants and handoffs", async () => {
  const t = await setup()
  codingSession(t, "a1", "/projA")
  codingSession(t, "b1", "/projB")
  await writeMechanicalHandoff(t.deps, "a1")
  await writeMechanicalHandoff(t.deps, "b1")
  await t.call("memory_write", "a1", { fact: "A global fact" })
  const count = async () => (await t.store.getStore()).handoffs.length

  await t.call("memory_clear", "a1", { summaryOnly: true })
  expect(await count()).toBe(2)
  await t.call("memory_clear", "a1", { scope: "global" })
  expect(await count()).toBe(2)
  expect(await t.call("memory_clear", "a1", { scope: "project" })).toBe("Cleared 1 handoff.")
  const remaining = (await t.store.getStore()).handoffs
  expect(remaining.map((handoff) => handoff.projectID)).toEqual(["/projB"])
  expect(await t.call("memory_clear", "a1")).toBe("Cleared 1 handoff.")
  expect(await count()).toBe(0)
})
