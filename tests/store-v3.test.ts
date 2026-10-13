import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyStore } from "../src/core.ts"
import { createStore } from "../src/store.ts"

// Same shape as the legacy store scripts/verify-runtime.ts seeds.
const v2Store = {
  version: 2,
  summary: "Lives in Turin.",
  updatedAt: 42,
  entries: [
    { id: "legacy", text: "The user lives in Turin.", category: "preferences", scope: "global", weight: 3, created: 1, lastSeen: 2, source: "explicit", tier: "core", status: "ACTIVE", sensitivity: "normal" },
    { id: "private", text: "SECRET_LOCAL_ONLY", category: "preferences", scope: "global", sensitivity: "local-only", weight: 3, created: 1, lastSeen: 2, source: "explicit", tier: "core", status: "ACTIVE" },
  ],
}

test("emptyStore is version 3 with no handoffs", () => {
  expect(emptyStore()).toEqual({ version: 3, summary: "", updatedAt: 0, entries: [], handoffs: [] })
})

test("a v2 store survives read -> write -> read and gains handoffs: []", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rem-memory-v3-"))
  try {
    await writeFile(join(dir, "store.json"), JSON.stringify(v2Store))
    const io = createStore(dir)
    const first = await io.getStore()
    expect(first.version).toBe(3)
    expect(first.handoffs).toEqual([])
    await io.writeStore(first)
    const onDisk = JSON.parse(await readFile(join(dir, "store.json"), "utf8"))
    expect(onDisk.version).toBe(3)
    expect(onDisk.handoffs).toEqual([])
    const second = await io.getStore()
    expect(second).toEqual(first)
    const { handoffs: _handoffs, ...rest } = second
    expect({ ...rest, version: 2 }).toEqual(v2Store as never)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
