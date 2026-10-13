import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.ts"
import { consolidate } from "../src/engine/dream.ts"
import type { EngineDeps, Host, TranscriptMessage } from "../src/engine/host.ts"
import { createSurface } from "../src/engine/surface.ts"
import { createTools, MEMORY_TOOL_NAMES } from "../src/engine/tools.ts"
import { createStore } from "../src/store.ts"

// Runs the engine against an in-memory Host: no OpenCode involved.
test("engine tools, surface and dream run against a fake Host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rem-memory-fake-host-"))
  try {
    const prompts: string[] = []
    const transcript: TranscriptMessage[] = [
      { id: "u1", type: "user", text: "I prefer teal terminals.", time: 100 },
      { id: "a1", type: "assistant", text: "Noted.\n[tool]", time: 101 },
    ]
    const host: Host = {
      name: "opencode",
      session: async () => ({ directory: "/project", title: "Fake" }),
      directoryFor: async () => "/project",
      generate: async (prompt) => {
        prompts.push(prompt)
        return JSON.stringify({ new: [{ text: "The user prefers teal terminal themes.", category: "preferences", scope: "global", confidence: 0.9 }], update: [], delete: [], conflicts: [], summary: "Likes teal." })
      },
      transcript: async () => transcript,
      lastUserText: async () => "which terminal color do I prefer?",
      log: () => {},
    }
    const config = resolveConfig({ dir, rerank: false })
    const deps: EngineDeps = { host, config, store: createStore(dir) }
    const surface = createSurface(deps)
    const tools = new Map(createTools(deps, surface).map((tool) => [tool.name, tool]))
    expect([...tools.keys()]).toEqual([...MEMORY_TOOL_NAMES])
    const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args, { sessionID: "s1" })

    expect(await call("memory_write", { fact: "Deploys go through staging first.", category: "preferences" })).toBe("Remembered (global): Deploys go through staging first.")
    expect(await call("memory_read", {})).toContain("Deploys go through staging first.")

    await consolidate(deps, "s1")
    expect(prompts[0]).toContain("TRANSCRIPT (session title: Fake):\nuser: I prefer teal terminals.\n\nassistant: Noted.\n[tool]")
    expect(await call("memory_read", { query: "teal" })).toContain("The user prefers teal terminal themes.")
    // a second pass with an unchanged transcript is a no-op
    await consolidate(deps, "s1")
    expect(prompts.length).toBe(2) // dedup check ran once for the first pass, nothing for the second

    const block = await surface.buildMemoryBlock("s1")
    expect(block).toContain("<memory>")
    expect(block).toContain("The user prefers teal terminal themes.")
    expect(await call("memory_inspect", { show: "surfaced" })).toContain("Why was this memory surfaced?")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
