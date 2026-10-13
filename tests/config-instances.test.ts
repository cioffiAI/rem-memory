// @ts-nocheck — focused fake context for the OpenCode adapter.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"

function entries(dir: string) {
  return JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).entries
}

test("keeps opencode.jsonc options and store paths separate per instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-options-"))
  function context(dir: string, directory: string, surface: boolean) {
    const tools = []
    const hooks = {}
    const ctx = {
      options: { dir, dream: false, surface },
      location: { directory },
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
          return { dispose: async () => {} }
        },
        list: async () => tools.map((tool) => ({ id: tool.name })),
      },
      session: {
        hook: async (name, callback) => {
          hooks[name] = callback
          return { dispose: async () => {} }
        },
        get: async () => ({ location: { directory } }),
        context: async () => [],
      },
    }
    return { ctx, tools, hooks }
  }
  try {
    const a = context(join(root, "a"), "/project-a", false)
    const b = context(join(root, "b"), "/project-b", true)
    const cleanupA = await plugin.setup(a.ctx)
    const cleanupB = await plugin.setup(b.ctx)
    const toolContext = { sessionID: "session", signal: new AbortController().signal, progress: async () => {} }
    await a.tools.find((tool) => tool.name === "memory_write").execute({ fact: "Project A prefers tea.", category: "preferences" }, toolContext)
    await b.tools.find((tool) => tool.name === "memory_write").execute({ fact: "Project B prefers coffee.", category: "preferences" }, toolContext)
    expect(entries(join(root, "a")).map((entry) => entry.text)).toEqual(["Project A prefers tea."])
    expect(entries(join(root, "b")).map((entry) => entry.text)).toEqual(["Project B prefers coffee."])
    expect(a.hooks.context).toBeUndefined()
    const event = { sessionID: "session", system: [] }
    await b.hooks.context(event)
    expect(event.system.map((part) => part.text).join("\n")).toContain("Project B prefers coffee.")
    expect(event.system.map((part) => part.text).join("\n")).not.toContain("Project A prefers tea.")
    await cleanupA()
    await cleanupB()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
