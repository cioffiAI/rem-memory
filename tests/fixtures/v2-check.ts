// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises"
import plugin from "../../src/index.ts"

const directory = process.cwd()
const sessionID = "v2-session"
const sweepOnly = process.env.V2_CHECK_SWEEP_ONLY === "1"
const tools = []
const hooks = {}
let generateCalls = 0
let foreignReads = 0
const disposed = []
const failSetup = process.env.V2_CHECK_FAIL_SETUP === "1"
const dreamDisabled = process.env.V2_CHECK_DREAM_DISABLED === "1"
const surfaceDisabled = process.env.V2_CHECK_SURFACE_DISABLED === "1"
const summaryDisabled = process.env.REM_MEMORY_SUMMARY === "0"
const handoffCheck = process.env.V2_CHECK_HANDOFF === "1"
const eventType = process.env.V2_CHECK_EVENT ?? "session.execution.succeeded"

const contextMessages = [
  { id: "user-1", type: "user", text: "I prefer teal terminal themes.", time: { created: 100 } },
  {
    id: "assistant-1",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text: "Understood." }],
    ...(handoffCheck || process.env.V2_CHECK_SNAPSHOT === "1" ? { snapshot: { start: "a", end: "b", files: ["src/a.ts"] } } : {}),
    time: { created: 101, completed: 102 },
  },
  { id: "idle-1", type: "idle", outcome: "succeeded", time: { created: 103 } },
]

const ctx = {
  app: { name: "opencode", version: "2.0.11", channel: "test" },
  location: { directory, project: { id: "project", directory, canonical: directory } },
  options: {},
  tool: {
    transform: async (callback) => {
      callback({ add: (definition) => tools.push(definition) })
      return { dispose: async () => { disposed.push("tools") } }
    },
    list: async () => tools.map((tool) => ({ ...tool, id: tool.name })),
  },
  session: {
    hook: async (name, callback) => {
      if (failSetup) throw new Error("simulated hook registration failure")
      hooks[name] = callback
      return { dispose: async () => { disposed.push(name) } }
    },
    // Mirrors OpenCode: session.generate sends the session's tools, system
    // prompt and conversation unless the plugin's generate hook strips them.
    generate: async ({ sessionID: id, prompt }) => {
      const provider = process.env.V2_CHECK_PROVIDER ?? "test"
      const request = {
        sessionID: id,
        model: { providerID: provider, id: "test" },
        tools: { edit: { description: "edit", input: {} }, shell: { description: "shell", input: {} } },
        system: [{ type: "text", text: "SESSION SYSTEM PROMPT" }],
        messages: [{ role: "user", content: "earlier conversation" }, { role: "user", content: prompt }],
      }
      if (!hooks.generate) throw new Error("internal generation ran without the stripping hook")
      await hooks.generate(request)
      // OpenCode's free tier needs the definitions (never executed by session.generate).
      if (provider === "opencode" ? Object.keys(request.tools).length === 0 : Object.keys(request.tools).length !== 0) {
        throw new Error(`internal generation tool definitions wrong for provider ${provider}`)
      }
      if (request.system.length !== 0) throw new Error("internal generation kept the session system prompt")
      if (request.messages.length !== 1 || request.messages[0].content !== prompt) throw new Error("internal generation kept the conversation")
      return ctx.generate.text({ prompt })
    },
    get: async ({ sessionID: id }) => ({
      id,
      projectID: "project",
      model: { providerID: "test", id: "test" },
      title: "V2 adapter test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 103, idle: 103 },
      location: { directory: id === "foreign-session" ? `${directory}/other-project` : directory },
    }),
    context: async ({ sessionID: id }) => {
      if (id === "foreign-session") {
        foreignReads++
        throw new Error("foreign project session must never be consolidated")
      }
      return contextMessages
    },
  },
  event: {
    subscribe: async function* ({ signal }) {
      yield { type: "session.execution.succeeded", data: { sessionID: "foreign-session" } }
      if (!sweepOnly) yield {
        type: eventType,
        ...(eventType === "session.idle" ? { location: { directory } } : {}),
        data: { sessionID },
      }
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    },
  },
  generate: {
    text: async (input) => {
      generateCalls++
      if (summaryDisabled && JSON.stringify(input).includes('"summary"')) throw new Error("disabled summary requested by DREAM")
      return {
        text: JSON.stringify({
          new: [{ text: "The user prefers teal terminal themes.", category: "preferences", scope: "global", confidence: 0.95 }],
          update: [],
          delete: [],
          conflicts: [],
          summary: "The user prefers teal terminal themes.",
        }),
      }
    },
  },
}

if (plugin.id !== "cioffi.rem-memory" || typeof plugin.setup !== "function") {
  throw new Error("plugin export is invalid")
}

if (sweepOnly) {
  await mkdir(process.env.REM_MEMORY_DIR, { recursive: true })
  await writeFile(`${process.env.REM_MEMORY_DIR}/state.json`, JSON.stringify({
    sessions: {},
    inProgress: {
      [sessionID]: { targetTs: 103, startedAt: 0 },
    },
  }))
}

if (failSetup) {
  try {
    await plugin.setup(ctx)
    throw new Error("setup should have failed")
  } catch (error) {
    if (error.message !== "simulated hook registration failure") throw error
  }
  if (JSON.stringify(disposed) !== '["tools"]') throw new Error("failed setup leaked tool registration")
  console.log("V2_CHECK_OK")
  process.exit(0)
}

const cleanup = await plugin.setup(ctx)
if (tools.length !== 10) throw new Error(`expected 10 V2 tools, got ${tools.length}`)
if (surfaceDisabled === Boolean(hooks.context)) throw new Error("SURFACE hook registration does not match configuration")

const storePath = `${process.env.REM_MEMORY_DIR}/store.json`
let store
if (dreamDisabled) {
  await Bun.sleep(30)
  if (generateCalls !== 0) throw new Error("DREAM generated text while disabled")
  try {
    store = JSON.parse(await readFile(storePath, "utf8"))
    if (store.entries.some((entry) => entry.source === "dreamed")) throw new Error("DREAM wrote a fact while disabled")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
} else {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      store = JSON.parse(await readFile(storePath, "utf8"))
      if (store.entries.some((entry) => entry.source === "dreamed")) break
    } catch {}
    await Bun.sleep(10)
  }
  if (!store?.entries.some((entry) => entry.source === "dreamed" && entry.sourceSessionID === sessionID)) {
    throw new Error(`${sweepOnly ? "recovery sweep" : "session.idle"} did not run V2 DREAM consolidation`)
  }
  if (generateCalls !== 1) throw new Error(`expected one tool-free generate call, got ${generateCalls}`)
  if (summaryDisabled && store.summary) throw new Error("DREAM stored a summary while disabled")
  if (!summaryDisabled && !store.summary) throw new Error("enabled DREAM did not store its summary")
}

if (handoffCheck) {
  let handoffs = []
  for (let attempt = 0; attempt < 100 && handoffs.length === 0; attempt++) {
    try { handoffs = JSON.parse(await readFile(storePath, "utf8")).handoffs ?? [] } catch {}
    if (handoffs.length === 0) await Bun.sleep(10)
  }
  const [handoff] = handoffs
  if (handoffs.length !== 1 || handoff.sessionID !== sessionID || handoff.projectID !== directory) throw new Error("completion event did not write exactly one mechanical handoff")
  if (handoff.level !== "mechanical" || handoff.request !== "I prefer teal terminal themes.") throw new Error("mechanical handoff has the wrong level or request")
  if (JSON.stringify(handoff.files) !== JSON.stringify([{ path: "src/a.ts", status: "modified" }])) throw new Error("mechanical handoff lost the touched files")
  const show = tools.find((tool) => tool.name === "memory_handoff")
  if (!String((await show.execute({ action: "show" }, { sessionID, agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} })).content).includes("src/a.ts")) throw new Error("memory_handoff show did not return the handoff")
} else {
  const stored = JSON.parse(await readFile(storePath, "utf8").catch(() => "{}"))
  if ((stored.handoffs ?? []).length !== 0) throw new Error("a trivial session produced a handoff")
}

const toolContext = {
  sessionID,
  agent: "build",
  messageID: "tool-message",
  id: "tool-call",
  signal: new AbortController().signal,
  progress: async () => {},
}
const write = tools.find((tool) => tool.name === "memory_write")
const read = tools.find((tool) => tool.name === "memory_read")
await write.execute({ fact: "The user drinks coffee in the morning.", category: "preferences" }, toolContext)
await write.execute({ fact: "SECRET_LOCAL_ONLY_VALUE", sensitivity: "local-only" }, toolContext)

const secretRead = await read.execute({ query: "SECRET_LOCAL_ONLY_VALUE" }, toolContext)
if (String(secretRead.content) !== "No memory entries found.") throw new Error("local-only entry leaked through memory_read")

const event = {
  sessionID,
  system: [],
  messages: [],
  tools: {},
  options: {},
  agent: "build",
  model: { providerID: "test", id: "test" },
}
if (hooks.context) {
  await hooks.context(event)
  const block = event.system.map((part) => part.text).join("\n")
  if (!block.includes("<memory>")) throw new Error("V2 context hook did not inject memory")
  if (block.includes("SECRET_LOCAL_ONLY_VALUE")) throw new Error("local-only entry leaked through context hook")
} else if (event.system.length !== 0) {
  throw new Error("SURFACE injected memory while disabled")
}

await cleanup?.()
await cleanup?.()
const expectedDisposed = JSON.stringify([...(surfaceDisabled ? [] : ["context"]), ...(dreamDisabled ? [] : ["generate"]), "tools"])
if (JSON.stringify(disposed) !== expectedDisposed) throw new Error("cleanup must dispose registrations exactly once in reverse order")
if (foreignReads !== 0) throw new Error("a completion event from another project reached consolidation")
console.log("V2_CHECK_OK")
