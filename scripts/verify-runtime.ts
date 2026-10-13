// Run against a real CLI with an isolated profile and a local mock model.
// OPENCODE_TEST_BIN=/path/to/opencode bun run verify:runtime  (OpenCode V2 only)
// OPENCODE_TEST_PACKAGE may point to a clean installed tarball instead of this checkout.
// OPENCODE_TEST_DISABLE_AUTO=1 also checks that DREAM and SURFACE stay off.
// OPENCODE_TEST_CONFIG_OPTIONS=1 supplies those switches and dir through
// opencode.jsonc, against conflicting environment values.
// OPENCODE_TEST_DISABLE_SUMMARY=1 checks hidden context/tool output and DREAM
// ignoring unsolicited summary output. Every run exercises parallel writes
// and clearing the summary without deleting facts.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startMockModel } from "../tests/fixtures/mock-model.ts"

const binary = process.env.OPENCODE_TEST_BIN
if (!binary) throw new Error("Set OPENCODE_TEST_BIN to an existing CLI binary; this script never downloads a CLI")
const configOptions = process.env.OPENCODE_TEST_CONFIG_OPTIONS === "1"
const disableSummary = process.env.OPENCODE_TEST_DISABLE_SUMMARY === "1"
const summaryMarker = "STALE_SUMMARY_RUNTIME_MARKER"
const disableAutomatic = process.env.OPENCODE_TEST_DISABLE_AUTO === "1" || configOptions
const root = realpathSync(mkdtempSync(join(tmpdir(), "rem-memory-runtime-")))
const project = join(root, "project")
const memory = join(root, "memory")
const configDir = join(root, "config", "opencode")
for (const dir of [project, memory, configDir]) mkdirSync(dir, { recursive: true })
const packageDir = resolve(process.env.OPENCODE_TEST_PACKAGE ?? join(import.meta.dir, ".."))
const model = startMockModel()
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = probe.port!
probe.stop(true)
const password = crypto.randomUUID()
const cliEnv = {
  PATH: process.env.PATH!,
  XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG: join(configDir, configOptions ? "opencode.jsonc" : "opencode.json"),
  // Only the locally configured test model is needed. Avoid catalog/update
  // network requests while booting an otherwise empty CLI profile.
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
  REM_MEMORY_DIR: configOptions ? join(root, "wrong-memory") : memory,
  REM_MEMORY_DELAY_MS: "100",
  REM_MEMORY_SWEEP_START_MS: "600000", REM_MEMORY_DEBUG: "1",
  REM_MEMORY_SUMMARY: configOptions || !disableSummary ? "1" : "0",
  ...(configOptions
    ? { REM_MEMORY_DREAM: "1", REM_MEMORY_SURFACE: "1" }
    : disableAutomatic ? { REM_MEMORY_DREAM: "0", REM_MEMORY_SURFACE: "0" } : {}),
}
const configuredPackage = configOptions
  ? { dir: memory, dream: false, surface: false, summary: !disableSummary }
  : undefined
const config = {
  plugins: [configuredPackage ? { package: packageDir, options: configuredPackage } : packageDir], model: "memory-test/test",
  providers: { "memory-test": {
    package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.server.port}/v1`, apiKey: "test" },
    models: { test: { name: "Compatibility test", limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}
writeFileSync(cliEnv.OPENCODE_CONFIG, JSON.stringify(config))
// Verify existing stores survive the runtime transition, including local-only data.
writeFileSync(join(memory, "store.json"), JSON.stringify({ version: 1, summary: summaryMarker, updatedAt: 0, entries: [
  { id: "legacy", text: "The user lives in Turin.", category: "preferences", scope: "global", weight: 3, created: Date.now(), lastSeen: Date.now(), source: "explicit" },
  { id: "private", text: "SECRET_LOCAL_ONLY_COMPAT", category: "preferences", scope: "global", sensitivity: "local-only", weight: 3, created: Date.now(), lastSeen: Date.now(), source: "explicit" },
] }))
const version = Bun.spawnSync([binary, "--version"], { env: cliEnv, cwd: project })
if (version.exitCode !== 0) throw new Error(version.stderr.toString())
console.log(`verify:runtime — ${version.stdout.toString().trim()}, profile ${root}`)
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
  env: cliEnv, cwd: project, stdout: "pipe", stderr: "pipe",
})
let logs = ""
async function capture(stream: ReadableStream<Uint8Array>) {
  for await (const chunk of stream) logs += new TextDecoder().decode(chunk)
}
const capturing = Promise.all([capture(child.stdout), capture(child.stderr)])
const base = `http://127.0.0.1:${port}`
async function api(path: string, data?: unknown): Promise<any> {
  const url = new URL(path, base)
  url.searchParams.set("directory", project)
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json", "x-opencode-directory": project },
    ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0,1000)}`)
  if (!text) return undefined
  const value = JSON.parse(text)
  return value && typeof value === "object" && "data" in value ? value.data : value
}
async function until(check: () => unknown | Promise<unknown>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout
  let last: unknown
  while (Date.now() < end) {
    try { if (await check()) return } catch (error) { last = error }
    if (child.exitCode !== null) throw new Error(`CLI exited (${child.exitCode})`)
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last})` : ""}`)
}
const store = () => JSON.parse(readFileSync(join(memory, "store.json"), "utf8"))
try {
  await until(async () => {
    return (await api("/api/plugin")).some((plugin: any) => plugin.id === "cioffi.rem-memory" && plugin.state.status === "active")
  }, "plugin loaded")
  const session = await api("/api/session", {
    title: "Memory compatibility test",
    model: { providerID: "memory-test", id: "test" }, permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  const prefix = `/api/session/${session.id}`
  async function sendAndCheck(text: string, expected: string) {
    const before = model.requests.length
    const prompt = text === "WRITE_TEST" ? `${text}: I prefer teal terminal themes.` : text
    await api(`${prefix}/prompt`, { text: prompt })
    await until(() => model.requests.slice(before).some((request) => request.messages?.some((message: any) =>
      message.role === "tool" && JSON.stringify(message).includes(expected))), `${text} tool result`)
    await until(async () => (await api(`${prefix}/context`)).at(-1)?.type === "idle", "session idle")
  }
  await sendAndCheck("WRITE_TEST", "Remembered")
  await sendAndCheck("READ_TEST", "coffee in the morning")
  if (disableAutomatic) {
    await Bun.sleep(500)
    if (store().entries.some((entry: any) => entry.source === "dreamed")) throw new Error("DREAM wrote while disabled")
  } else {
    await until(() => store().entries.some((entry: any) => entry.source === "dreamed" && entry.text.includes("teal terminal")), "automatic DREAM", 40_000)
  }
  // Exercise explicit preferences after consolidation: they intentionally
  // overlap the existing DREAM lexical dedup guard's boilerplate words.
  await sendAndCheck("PARALLEL_TEST", "Remembered")
  const saved = store()
  for (const fact of ["The user prefers that repositories be useful and non-wordy.", "The user prefers concise responses."]) {
    if (!saved.entries.some((entry: any) => entry.text === fact)) throw new Error(`parallel write lost: ${fact}`)
  }
  if (saved.version !== 3 || saved.entries.find((entry: any) => entry.id === "legacy")?.tier !== "core") throw new Error("store migration lost legacy data")
  const allRequests = JSON.stringify(model.requests)
  const injectedMemory = model.requests.some((request) => request.messages.some((message: any) =>
    message.role === "system" && JSON.stringify(message).includes("<memory>")))
  const injectedExplicit = model.requests.some((request) => request.messages.some((message: any) =>
    message.role === "system" && JSON.stringify(message).includes("<memory>") && JSON.stringify(message).includes("coffee in the morning")))
  if (disableAutomatic && injectedMemory) throw new Error("SURFACE injected while disabled")
  if (!disableAutomatic && !injectedExplicit) throw new Error("written memory missing from model context")
  if (allRequests.includes("SECRET_LOCAL_ONLY_COMPAT")) throw new Error("local-only memory reached the model")
  if (disableSummary && (allRequests.includes(summaryMarker) || saved.summary !== summaryMarker)) throw new Error("disabled summary leaked or was updated by DREAM")
  if (disableSummary && model.requests.some((request) => request.messages.some((message: any) =>
    message.role === "system" && JSON.stringify(message).includes("<summary>")))) throw new Error("disabled summary tag reached model context")
  const internal = model.requests.filter((request) => /You are (the memory consolidation module|a deduplication checker)/.test(JSON.stringify(request.messages)))
  if (disableAutomatic && internal.length) throw new Error("DREAM called the model while disabled")
  if (!disableAutomatic && (!internal.length || internal.some((request) => request.tools?.length))) throw new Error("DREAM/dedup exposed tools")
  const names = ["read", "write", "update", "why", "inspect", "useful", "irrelevant", "forget", "clear", "handoff"].map((name) => `memory_${name}`)
  if (names.some((name) => !allRequests.includes(name))) throw new Error("not all ten memory tools reached the model")
  await sendAndCheck("CLEAR_SUMMARY_TEST", "Cleared memory summary")
  // With summary/DREAM enabled, the completion event may regenerate a summary
  // immediately after the clear tool finishes. Disabled runs must stay empty.
  if ((disableSummary || disableAutomatic) && store().summary !== "") throw new Error("summary-only clear left summary behind")
  if (JSON.stringify(store().entries.map((entry: any) => entry.id).sort()) !== JSON.stringify(saved.entries.map((entry: any) => entry.id).sort())) {
    throw new Error("summary-only clear lost facts")
  }
  // Native /memory command: executing it must make the model receive the
  // instructions of commands/memory.md followed by the user's arguments.
  if (!(await api("/api/command")).some((command: any) => command.name === "memory")) throw new Error("/memory command not registered")
  const beforeCommand = model.requests.length
  await api(`${prefix}/command`, { name: "memory", text: "stats" })
  await until(() => model.requests.slice(beforeCommand).some((request) => {
    const text = JSON.stringify(request.messages)
    return text.includes("memory_handoff") && text.includes("User request: stats")
  }), "/memory command prompt reached the model")
  await until(async () => (await api(`${prefix}/context`)).at(-1)?.type === "idle", "session idle after command")
  console.log("OK: native /memory command forwards its instructions and arguments to the model")
  console.log(`OK: parallel writes through Code Mode Promise.all, summary-only clear${disableSummary ? ", summary hidden and DREAM summary disabled" : ""}`)
  console.log(disableAutomatic
    ? `OK: real CLI load, ten tools, write/read, DREAM and SURFACE disabled${configOptions ? " through opencode.jsonc" : ""}, migration, local-only privacy`
    : `OK: real CLI load, ten tools, write/read, context, DREAM, migration, local-only privacy, tool-free internal calls`)
  writeFileSync(join(root, "result.json"), JSON.stringify({ version: version.stdout.toString().trim(), packageDir, checks: "passed", requests: model.requests.length, internalCalls: internal.length }, null, 2))
} finally {
  child.kill("SIGTERM")
  await Promise.race([child.exited, Bun.sleep(3000)])
  if (child.exitCode === null) child.kill("SIGKILL")
  await capturing
  model.server.stop(true)
  writeFileSync(join(root, "server.log"), logs.replaceAll(password, "[test password]"))
  writeFileSync(join(root, "requests.json"), JSON.stringify(model.requests, null, 2))
  console.log(`Evidence: ${root}`)
}
