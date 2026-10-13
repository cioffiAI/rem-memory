import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  anchorState,
  createAnchor,
  createAnchorCache,
  entryAnchorState,
  parseAnchorSpec,
  refreshAnchors,
  resolveInside,
} from "../src/engine/anchors.ts"
import type { Entry } from "../src/core.ts"

let project: string
let outside: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "rem-anchor-project-"))
  outside = await mkdtemp(join(tmpdir(), "rem-anchor-outside-"))
  await mkdir(join(project, "src"))
  await writeFile(join(project, "src", "store.ts"), "export function withLock() { return 1 }\n")
  await writeFile(join(outside, "secret.txt"), "top secret")
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("parseAnchorSpec handles paths, symbols and rejects bad input", () => {
  expect(parseAnchorSpec("src/x.ts")).toEqual({ path: "src/x.ts" })
  expect(parseAnchorSpec("./src//x.ts#withLock")).toEqual({ path: "src/x.ts", symbol: "withLock" })
  expect(() => parseAnchorSpec("")).toThrow()
  expect(() => parseAnchorSpec("   ")).toThrow()
  expect(() => parseAnchorSpec("#sym")).toThrow()
  expect(() => parseAnchorSpec("src/x.ts#")).toThrow()
  expect(() => parseAnchorSpec("src/x.ts#two words")).toThrow()
  expect(() => parseAnchorSpec("/etc/passwd")).toThrow(/absolute/)
  expect(() => parseAnchorSpec("../x")).toThrow(/outside/)
  expect(() => parseAnchorSpec("a/../../x")).toThrow(/outside/)
})

test("resolveInside rejects traversal, absolute paths and symlink escapes", async () => {
  await expect(resolveInside(project, "../x")).rejects.toThrow(/outside/)
  await expect(resolveInside(project, join(outside, "secret.txt"))).rejects.toThrow(/outside/)
  await symlink(join(outside, "secret.txt"), join(project, "link.txt"))
  await symlink(outside, join(project, "linkdir"))
  await expect(resolveInside(project, "link.txt")).rejects.toThrow(/outside/)
  await expect(resolveInside(project, "linkdir/secret.txt")).rejects.toThrow(/outside/)
  await expect(createAnchor("link.txt", project, 1)).rejects.toThrow(/outside/)
  await expect(resolveInside(project, "src/store.ts")).resolves.toContain("store.ts")
  await expect(resolveInside(project, "src/none.ts")).rejects.toThrow(/does not exist/)
})

test("an internal symlink is allowed, and an escaping stored anchor is broken, never read", async () => {
  await symlink(join(project, "src", "store.ts"), join(project, "alias.ts"))
  await expect(createAnchor("alias.ts", project, 1)).resolves.toMatchObject({ path: "alias.ts" })
  const anchor = await createAnchor("src/store.ts", project, 1)
  await symlink(join(outside, "secret.txt"), join(project, "link.txt"))
  const result = await anchorState({ ...anchor, path: "link.txt" }, project, createAnchorCache())
  expect(result).toMatchObject({ state: "broken", reason: "outside project" })
})

test("createAnchor hashes content and validates file and symbol", async () => {
  const anchor = await createAnchor("src/store.ts#withLock", project, 42)
  expect(anchor).toMatchObject({ path: "src/store.ts", symbol: "withLock", anchoredAt: 42 })
  expect(anchor.hash).toMatch(/^[0-9a-f]{16}$/)
  await expect(createAnchor("src/missing.ts", project, 1)).rejects.toThrow(/does not exist/)
  await expect(createAnchor("src/store.ts#nope", project, 1)).rejects.toThrow(/not found/)
  await expect(createAnchor("src", project, 1)).rejects.toThrow(/not a readable file/)
})

test("state transitions: fresh, drifted, broken, and back", async () => {
  const cache = createAnchorCache()
  const file = join(project, "src", "store.ts")
  const withSymbol = await createAnchor("src/store.ts#withLock", project, 1)
  const noSymbol = await createAnchor("src/store.ts", project, 1)
  expect((await anchorState(withSymbol, project, cache)).state).toBe("fresh")

  await writeFile(file, "export function withLock() { return 2 }\n")
  expect((await anchorState(withSymbol, project, cache)).state).toBe("drifted")
  expect((await anchorState(noSymbol, project, cache)).state).toBe("drifted")

  await writeFile(file, "export function other() {}\n")
  expect(await anchorState(withSymbol, project, cache)).toMatchObject({ state: "broken", reason: "symbol missing" })
  expect((await anchorState(noSymbol, project, cache)).state).toBe("drifted")

  await rm(file)
  expect(await anchorState(withSymbol, project, cache)).toMatchObject({ state: "broken", reason: "file missing" })
  expect((await anchorState(noSymbol, project, cache)).state).toBe("broken")

  await writeFile(file, "export function withLock() { return 1 }\n")
  expect((await anchorState(withSymbol, project, cache)).state).toBe("fresh")
  expect((await anchorState(noSymbol, project, cache)).state).toBe("fresh")
})

test("symbols with regex metacharacters and identifier boundaries", async () => {
  await writeFile(join(project, "m.ts"), "const v = $store.get(1)\nlet n = a+b\nconst xwithLock2 = 1\n")
  await expect(createAnchor("m.ts#$store.get", project, 1)).resolves.toBeDefined()
  await expect(createAnchor("m.ts#a+b", project, 1)).resolves.toBeDefined()
  // "." and "+" are literal, not regex operators
  await expect(createAnchor("m.ts#$store_get", project, 1)).rejects.toThrow()
  await expect(createAnchor("m.ts#aab", project, 1)).rejects.toThrow()
  // a substring of a longer identifier does not count
  await expect(createAnchor("m.ts#withLock", project, 1)).rejects.toThrow()
  await expect(createAnchor("m.ts#xwithLock2", project, 1)).resolves.toBeDefined()
})

test("files over 1 MB hash size:mtime instead of content", async () => {
  const big = join(project, "big.bin")
  await writeFile(big, "x")
  await truncate(big, 1024 * 1024 + 10)
  const anchor = await createAnchor("big.bin", project, 1)
  expect(anchor.hash.startsWith(`${1024 * 1024 + 10}:`)).toBe(true)
  const cache = createAnchorCache()
  expect((await anchorState(anchor, project, cache)).state).toBe("fresh")
  const later = new Date(Date.now() + 60_000)
  await utimes(big, later, later)
  expect((await anchorState(anchor, project, cache)).state).toBe("drifted")
})

test("cache is keyed by mtime and size", async () => {
  const cache = createAnchorCache()
  const file = join(project, "src", "store.ts")
  const anchor = await createAnchor("src/store.ts", project, 1)
  expect((await anchorState(anchor, project, cache)).state).toBe("fresh")
  expect(cache.size).toBe(1)
  // same size, new mtime and content: new key, state recomputed
  await writeFile(file, "export function withLock() { return 9 }\n")
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  expect((await anchorState(anchor, project, cache)).state).toBe("drifted")
  expect(cache.size).toBe(2)
  // unchanged file hits the cache
  await anchorState(anchor, project, cache)
  expect(cache.size).toBe(2)
})

test("entry state is the worst anchor; refreshAnchors keeps anchors of missing files", async () => {
  const cache = createAnchorCache()
  await writeFile(join(project, "b.ts"), "one")
  const a = await createAnchor("src/store.ts", project, 1)
  const b = await createAnchor("b.ts", project, 1)
  const entry = { id: "e", text: "t", scope: "project", projectID: project, anchors: [a, b] } as Entry
  expect((await entryAnchorState(entry, cache)).state).toBe("fresh")
  await writeFile(join(project, "b.ts"), "two")
  expect((await entryAnchorState(entry, cache)).state).toBe("drifted")
  await rm(join(project, "src", "store.ts"))
  expect((await entryAnchorState(entry, cache)).state).toBe("broken")

  const refreshed = (await refreshAnchors(entry.anchors, project, 9, cache))!
  expect(refreshed[0]).toEqual(a) // file gone: old anchor kept
  expect(refreshed[1].hash).not.toBe(b.hash)
  expect(refreshed[1].anchoredAt).toBe(9)
  expect((await entryAnchorState({ ...entry, scope: "global" } as Entry, cache)).state).toBe("broken")
})
