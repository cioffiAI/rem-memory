import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { defaultDir, isDirExplicit, resetDeprecationWarnings, resolveConfig } from "../src/config.ts"

let warn: ReturnType<typeof spyOn>
beforeEach(() => {
  resetDeprecationWarnings()
  warn = spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

test("plugin options override environment values and preserve defaults", () => {
  const config = resolveConfig({
    dream: false,
    surface: false,
    summary: false,
    dir: "/tmp/memory-from-config",
    delayMs: 25,
    rerank: true,
    coreSlot: 0,
  }, {
    REM_MEMORY_DREAM: "1",
    REM_MEMORY_SURFACE: "1",
    REM_MEMORY_SUMMARY: "1",
    REM_MEMORY_DIR: "/tmp/memory-from-env",
    REM_MEMORY_DELAY_MS: "90",
    REM_MEMORY_MAX_FACTS: "7",
  })
  expect(config.dream).toBe(false)
  expect(config.surface).toBe(false)
  expect(config.summary).toBe(false)
  expect(config.dir).toBe("/tmp/memory-from-config")
  expect(config.delayMs).toBe(25)
  expect(config.maxFacts).toBe(7)
  expect(config.rerank).toBe(true)
  expect(config.coreSlot).toBe(0)
  expect(config.maxEntries).toBe(400)
})

test("every environment setting can be supplied through plugin options", () => {
  const options = {
    off: true, dream: false, surface: false, summary: false, dir: "/tmp/memory-all-options",
    debug: true, delayMs: 0, maxEntries: 1, maxFacts: 0, maxChars: 1,
    transcriptChars: 1, sweepIntervalMs: 1, sweepStartMs: 0, sweepBatch: 1,
    gcChildAgeMs: 0, inProgressTimeoutMs: 1, rerank: true,
    rerankCandidates: 1, rerankTimeoutMs: 1, rerankCacheMs: 0,
    coreSlot: 0, surfaceRefreshMs: 0,
    handoff: false, handoffMaxAgeHours: 1, handoffKeep: 1, handoffMaxChars: 100,
  }
  const { gcChildAgeMs: _ignored, ...effective } = options
  expect(resolveConfig(options, {})).toEqual(effective)
})

test("invalid options fail at setup with the offending name", () => {
  expect(() => resolveConfig({ dreem: false }, {})).toThrow("dreem")
  expect(() => resolveConfig({ dream: "false" }, {})).toThrow("dream")
  expect(() => resolveConfig({ summary: "false" }, {})).toThrow("summary")
  expect(() => resolveConfig({ delayMs: -1 }, {})).toThrow("delayMs")
  expect(() => resolveConfig({ rerankTimeoutMs: Infinity }, {})).toThrow("rerankTimeoutMs")
  expect(() => resolveConfig({ dir: "" }, {})).toThrow("dir")
  expect(() => resolveConfig({ dir: "relative/path" }, {})).toThrow("absolute")
})

test("summary is enabled by default and accepts a strict environment switch", () => {
  expect(resolveConfig({}, {}).summary).toBe(true)
  expect(resolveConfig({}, { REM_MEMORY_SUMMARY: "0" }).summary).toBe(false)
  expect(() => resolveConfig({}, { REM_MEMORY_SUMMARY: "false" })).toThrow("summary")
  expect(resolveConfig({ summary: false }, { REM_MEMORY_SUMMARY: "invalid" }).summary).toBe(false)
})

test("an invalid environment value cannot prevent a plugin option from taking precedence", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))})`],
    env: { ...process.env, REM_MEMORY_DELAY_MS: "invalid" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(resolveConfig({ delayMs: 25 }, { REM_MEMORY_DELAY_MS: "invalid" }).delayMs).toBe(25)
})

test("existing environment booleans keep their 1.7.0 behavior", () => {
  const config = resolveConfig({}, { REM_MEMORY_OFF: "false", REM_MEMORY_DEBUG: "no", REM_MEMORY_RERANK: "false" })
  expect(config.off).toBe(false)
  expect(config.debug).toBe(false)
  expect(config.rerank).toBe(false)
})

test("REM_MEMORY_* variables are read without any warning", () => {
  const config = resolveConfig({}, { REM_MEMORY_DELAY_MS: "42", REM_MEMORY_DREAM: "0", REM_MEMORY_DIR: "/tmp/rem" })
  expect(config.delayMs).toBe(42)
  expect(config.dream).toBe(false)
  expect(config.dir).toBe("/tmp/rem")
  expect(warn).not.toHaveBeenCalled()
})

test("legacy OPENCODE_MEMORY_* variables are a fallback and warn once, listing the names", () => {
  const env = { OPENCODE_MEMORY_DELAY_MS: "77", OPENCODE_MEMORY_SWEEP_MS: "5000", OPENCODE_MEMORY_DREAM: "0" }
  const config = resolveConfig({}, env)
  expect(config.delayMs).toBe(77)
  expect(config.sweepIntervalMs).toBe(5000)
  expect(config.dream).toBe(false)
  resolveConfig({}, env)
  resolveConfig({}, { OPENCODE_MEMORY_SURFACE: "0" })
  expect(warn).toHaveBeenCalledTimes(1)
  const message = String(warn.mock.calls[0][0])
  for (const name of ["OPENCODE_MEMORY_DELAY_MS", "OPENCODE_MEMORY_SWEEP_MS", "OPENCODE_MEMORY_DREAM"]) expect(message).toContain(name)
  expect(message).toContain("REM_MEMORY_SWEEP_MS")
})

test("REM_MEMORY_* wins over OPENCODE_MEMORY_* and a shadowed legacy name is not reported", () => {
  const config = resolveConfig({}, { REM_MEMORY_DELAY_MS: "1", OPENCODE_MEMORY_DELAY_MS: "2" })
  expect(config.delayMs).toBe(1)
  expect(warn).not.toHaveBeenCalled()
})

test("legacy boolean semantics apply to both prefixes", () => {
  for (const prefix of ["REM_MEMORY_", "OPENCODE_MEMORY_"]) {
    resetDeprecationWarnings()
    expect(resolveConfig({}, { [`${prefix}OFF`]: "1", [`${prefix}DEBUG`]: "1", [`${prefix}RERANK`]: "1" })).toMatchObject({ off: true, debug: true, rerank: true })
    expect(resolveConfig({}, { [`${prefix}OFF`]: "true", [`${prefix}DEBUG`]: "yes", [`${prefix}RERANK`]: "on" })).toMatchObject({ off: false, debug: false, rerank: false })
  }
})

test("gcChildAgeMs is accepted, validated, warned about once, and ignored", () => {
  const config = resolveConfig({ gcChildAgeMs: 5 }, {})
  expect("gcChildAgeMs" in config).toBe(false)
  resolveConfig({}, { REM_MEMORY_GC_CHILD_AGE_MS: "7" })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(String(warn.mock.calls[0][0])).toContain("gcChildAgeMs")
  expect(() => resolveConfig({ gcChildAgeMs: -1 }, {})).toThrow("gcChildAgeMs")
})

test("the default directory is under rem-memory and honors an injected home", () => {
  expect(resolveConfig({}, {}, "/home/test").dir).toBe("/home/test/.local/share/rem-memory")
  expect(defaultDir("/h")).toBe("/h/.local/share/rem-memory")
  expect(resolveConfig({ dir: "~/x" }, {}, "/home/test").dir).toBe("/home/test/x")
})

test("a directory is explicit when set through the option or either environment prefix", () => {
  expect(isDirExplicit({}, {})).toBe(false)
  expect(isDirExplicit({ dir: "/a" }, {})).toBe(true)
  expect(isDirExplicit({}, { REM_MEMORY_DIR: "/a" })).toBe(true)
  expect(isDirExplicit({}, { OPENCODE_MEMORY_DIR: "/a" })).toBe(true)
})
