// Isolated installation check for the artifact that will be published
// (issues #2/#3).
//
// A package that builds is not necessarily a package that runs: the plugin
// imports `@opencode/plugin` at load time, so the tarball a user installs
// must resolve that module from ITS OWN declared runtime dependencies, never
// from this checkout's devDependencies (or its node_modules). This script
// verifies exactly that, on the real artifact:
//
//   1. build                    (bun run build)
//   2. pack                     (bun pm pack: the actual tarball)
//   3. isolated install         (fresh temp dir OUTSIDE the checkout)
//   4. import by package name   (resolution happens against the install dir)
//   5. initialize V2            (the adapter registers nine tools and cleans up)
//
// Run with: bun run verify:package   (also part of prepublishOnly)
//
// NOT covered here (manual release checklist): loading the same tarball in a
// clean OpenCode profile, on every supported platform.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const PKG_NAME = "rem-memory"
const EXPECTED_TOOLS = [
  "memory_read",
  "memory_write",
  "memory_update",
  "memory_why",
  "memory_inspect",
  "memory_useful",
  "memory_irrelevant",
  "memory_forget",
  "memory_clear",
]

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const res = Bun.spawnSync({ cmd, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  if (res.exitCode !== 0) {
    process.stderr.write(res.stdout.toString())
    process.stderr.write(res.stderr.toString())
    throw new Error(`command failed (exit ${res.exitCode}): ${cmd.join(" ")}`)
  }
  return res.stdout.toString()
}

function step(message: string) {
  console.log(`verify:package — ${message}`)
}

// Executed by the isolated install: imports the package BY NAME (so Node/Bun
// resolves the runtime SDK inside the install dir), exercises the V2 setup()
// adapter, then disposes it.
const CHECK_SCRIPT = `
 import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
 import plugin from "${PKG_NAME}"

const EXPECTED = ${JSON.stringify(EXPECTED_TOOLS)}
const manifest = JSON.parse(readFileSync("node_modules/${PKG_NAME}/package.json", "utf8"))
if (!manifest.dependencies?.["@opencode/plugin"]) {
  console.error("FAIL: installed package does not declare @opencode/plugin in dependencies")
  process.exit(1)
}
if (plugin.id !== "cioffi.rem-memory" || typeof plugin.setup !== "function" || "server" in plugin) {
  console.error("FAIL: package does not expose the V2-only id/setup contract")
  process.exit(1)
}

const memoryDir = process.env.REM_MEMORY_DIR
mkdirSync(memoryDir, { recursive: true })
writeFileSync(memoryDir + "/store.json", JSON.stringify({
  version: 1,
  summary: "",
  updatedAt: 0,
  entries: [{
    id: "legacy-1",
    text: "The user prefers a dark terminal.",
    category: "preferences",
    scope: "global",
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "explicit"
  }]
}))

const expected = [...EXPECTED].sort()
async function verifyControls(call, dir) {
  const facts = [
    "The user prefers that repositories be useful and non-wordy.",
    "The user prefers concise responses.",
  ]
  await Promise.all(facts.map((fact) => call("memory_write", { fact, category: "preferences" })))
  const path = dir + "/store.json"
  const saved = JSON.parse(readFileSync(path, "utf8"))
  if (facts.some((fact) => !saved.entries.some((entry) => entry.text === fact))) throw new Error("packed adapter lost a parallel write")
  saved.summary = "PACKED_STALE_SUMMARY"
  writeFileSync(path, JSON.stringify(saved))
  if (String(await call("memory_read", {})).includes(saved.summary)) throw new Error("packed adapter exposed disabled summary")
  await call("memory_clear", { summaryOnly: true })
  const cleared = JSON.parse(readFileSync(path, "utf8"))
  if (cleared.summary !== "" || cleared.entries.length !== saved.entries.length) throw new Error("packed summary-only clear lost facts")
}
const v2Tools = []
const hooks = {}
const subscribe = async function* ({ signal } = {}) {
  if (signal?.aborted) return
  await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }))
}
const v2ctx = {
  app: { name: "opencode", version: "2.0.11", channel: "test" },
  location: { directory: process.cwd(), project: { id: "project", directory: process.cwd(), canonical: process.cwd() } },
  options: { dream: false, summary: false },
  tool: {
    transform: async (callback) => {
      callback({ add: (definition) => v2Tools.push(definition) })
      return { dispose: async () => {} }
    },
    list: async () => v2Tools.map((tool) => ({ ...tool, id: tool.name })),
  },
  session: {
    hook: async (name, callback) => {
      hooks[name] = callback
      return { dispose: async () => {} }
    },
    get: async ({ sessionID }) => ({
      id: sessionID,
      projectID: "project",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
      location: { directory: process.cwd() },
    }),
    context: async () => [{ id: "m1", type: "user", text: "coffee morning", time: { created: Date.now() } }],
  },
  event: { subscribe },
  generate: { text: async () => ({ text: '{"new":[],"summary":""}' }) },
}

const cleanup = await plugin.setup(v2ctx)
const v2Names = v2Tools.map((tool) => tool.name).sort()
if (JSON.stringify(v2Names) !== JSON.stringify(expected)) {
  console.error("FAIL: V2 registered tools mismatch")
  console.error("  expected:", expected.join(", "))
  console.error("  actual:  ", v2Names.join(", "))
  process.exit(1)
}
const write = v2Tools.find((tool) => tool.name === "memory_write")
const read = v2Tools.find((tool) => tool.name === "memory_read")
const toolContext = { sessionID: "s-v2", agent: "build", messageID: "m-v2", id: "call-v2", signal: new AbortController().signal, progress: async () => {} }
await write.execute({ fact: "The user drinks coffee in the morning.", category: "preferences" }, toolContext)
const result = await read.execute({ query: "coffee morning" }, toolContext)
if (!String(result.content).includes("coffee in the morning")) {
  console.error("FAIL: V2 memory_write/memory_read round trip failed", result)
  process.exit(1)
}
await verifyControls(async (name, args) => (await v2Tools.find((tool) => tool.name === name).execute(args, toolContext)).content, memoryDir)
const migrated = JSON.parse(readFileSync(memoryDir + "/store.json", "utf8"))
if (migrated.version !== 3 || migrated.entries.find((entry) => entry.id === "legacy-1")?.tier !== "core") {
  console.error("FAIL: installed package did not migrate the v1 store schema to v2")
  process.exit(1)
}
const event = { sessionID: "s-v2", system: [], messages: [], tools: {}, options: {}, agent: "build", model: { providerID: "test", id: "test" } }
await hooks.context(event)
if (!event.system.some((part) => part.type === "text" && part.text.includes("<memory>"))) {
  console.error("FAIL: V2 context hook did not inject memory")
  process.exit(1)
}
await cleanup?.()
console.log("OK V2: " + v2Names.length + " tools, migration/read/write/context, parallel writes, summary controls, cleanup")
`

const artifactsDir = mkdtempSync(join(tmpdir(), "rem-memory-artifacts-"))
const installDir = mkdtempSync(join(tmpdir(), "rem-memory-install-"))
let ok = false
try {
  step("build")
  run(["bun", "run", "build"], ROOT)

  step("pack the real tarball")
  const packed = run(
    ["bun", "pm", "pack", "--destination", artifactsDir, "--ignore-scripts", "--quiet"],
    ROOT,
  ).trim()
  const listed = packed.split("\n").map((l) => l.trim()).filter(Boolean)
  let tarball = listed[listed.length - 1] ?? ""
  if (!tarball.endsWith(".tgz")) {
    tarball = readdirSync(artifactsDir).filter((f) => f.endsWith(".tgz")).map((f) => join(artifactsDir, f))[0] ?? ""
  }
  if (!tarball) throw new Error(`could not locate packed tarball (pack output: ${packed || "(empty)"})`)
  step(`tarball: ${tarball}`)

  step("install in a clean directory outside the checkout")
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "rem-memory-install-check", private: true }, null, 2),
  )
  run(["bun", "add", tarball], installDir)

  step("import, exercise the V2 adapter, dispose")
  writeFileSync(join(installDir, "check.mjs"), CHECK_SCRIPT)
  const out = run(["bun", "check.mjs"], installDir, { REM_MEMORY_DIR: join(installDir, "memory") })
  process.stdout.write(out)

  const binary = process.env.OPENCODE_TEST_BIN_V2
  if (binary) {
    step("real OpenCode V2 against the installed tarball")
    process.stdout.write(run(["bun", join(ROOT, "scripts", "verify-runtime.ts")], ROOT, {
      OPENCODE_TEST_BIN: binary,
      OPENCODE_TEST_PACKAGE: join(installDir, "node_modules", PKG_NAME),
    }))
  }

  step("OK — the tarball runs standalone")
  ok = true
} finally {
  if (ok) {
    rmSync(artifactsDir, { recursive: true, force: true })
    rmSync(installDir, { recursive: true, force: true })
  } else {
    console.error(`verify:package FAILED — directories kept for inspection:\n  ${artifactsDir}\n  ${installDir}`)
    process.exitCode = 1
  }
}
