import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCommandPrompt, commandInstructions } from "../src/engine/command.ts"
import plugin from "../src/index.ts"

function context(options: Record<string, unknown>) {
  const commands: any[] = []
  const prompts: any[] = []
  const disposed: string[] = []
  const tools: any[] = []
  const ctx = {
    options: { dream: false, surface: false, handoff: false, ...options },
    location: { directory: "/project" },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.push(tool) })
        return { dispose: async () => {} }
      },
      list: async () => tools.map((tool) => ({ id: tool.name })),
    },
    command: {
      transform: async (callback: any) => {
        callback({ add: (command: any) => commands.push(command) })
        return { dispose: async () => { disposed.push("command") } }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async () => ({ location: { directory: "/project" } }),
      context: async () => [],
      prompt: async (input: any) => { prompts.push(input) },
    },
  } as any
  return { ctx, commands, prompts, disposed }
}

test("embedded instructions equal the body of commands/memory.md", () => {
  const file = readFileSync(join(import.meta.dir, "..", "commands", "memory.md"), "utf8")
  const body = file.split(/\r?\n---\r?\n/)[1]!.trim()
  expect(commandInstructions()).toBe(body)
  expect(commandInstructions()).not.toContain("description:")
  expect(commandInstructions()).toContain("memory_handoff")
})

test("buildCommandPrompt appends the user's arguments", () => {
  expect(buildCommandPrompt("")).toBe(commandInstructions())
  expect(buildCommandPrompt("  stats ")).toBe(`${commandInstructions()}\n\nUser request: stats`)
})

test("the /memory command is registered, forwards instructions with session.prompt and is disposed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rem-memory-command-"))
  try {
    const { ctx, commands, prompts, disposed } = context({ dir })
    const cleanup = await plugin.setup(ctx)
    expect(commands.map((command) => command.name)).toEqual(["memory"])
    expect(commands[0].description).toBeTruthy()
    await commands[0].execute({ sessionID: "ses_1", prompt: { text: "remember I like tea" }, delivery: "queue" })
    expect(prompts).toHaveLength(1)
    expect(prompts[0].sessionID).toBe("ses_1")
    expect(prompts[0].delivery).toBe("queue")
    expect(prompts[0].text).toContain(commandInstructions())
    expect(prompts[0].text.endsWith("User request: remember I like tea")).toBe(true)
    await cleanup?.()
    expect(disposed).toEqual(["command"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("command: false skips the registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rem-memory-command-"))
  try {
    const { ctx, commands, disposed } = context({ dir, command: false })
    const cleanup = await plugin.setup(ctx)
    expect(commands).toHaveLength(0)
    await cleanup?.()
    expect(disposed).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
