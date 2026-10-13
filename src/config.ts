// Plugin configuration and well-known paths, split out of the adapter so
// tests can import them without loading the OpenCode plugin runtime.

import path from "path"
import os from "os"

// $HOME wins over os.homedir() so tests (and sandboxes) can redirect it; on
// POSIX the two normally agree.
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir()
}

export function defaultDir(home: string = homeDir()): string {
  return path.join(home, ".local", "share", "rem-memory")
}

// Location used by rem-memory <= 1.x; only read by the one-time migration.
export function legacyDir(home: string = homeDir()): string {
  return path.join(home, ".local", "share", "opencode", "memory")
}

const ENV_PREFIX = "REM_MEMORY_"
const LEGACY_ENV_PREFIX = "OPENCODE_MEMORY_"

const OPTION_ENV = {
  off: "REM_MEMORY_OFF",
  dream: "REM_MEMORY_DREAM",
  surface: "REM_MEMORY_SURFACE",
  summary: "REM_MEMORY_SUMMARY",
  dir: "REM_MEMORY_DIR",
  debug: "REM_MEMORY_DEBUG",
  delayMs: "REM_MEMORY_DELAY_MS",
  maxEntries: "REM_MEMORY_MAX_ENTRIES",
  maxFacts: "REM_MEMORY_MAX_FACTS",
  maxChars: "REM_MEMORY_MAX_CHARS",
  transcriptChars: "REM_MEMORY_TRANSCRIPT_CHARS",
  sweepIntervalMs: "REM_MEMORY_SWEEP_MS",
  sweepStartMs: "REM_MEMORY_SWEEP_START_MS",
  sweepBatch: "REM_MEMORY_SWEEP_BATCH",
  gcChildAgeMs: "REM_MEMORY_GC_CHILD_AGE_MS",
  inProgressTimeoutMs: "REM_MEMORY_INPROGRESS_TIMEOUT_MS",
  rerank: "REM_MEMORY_RERANK",
  rerankCandidates: "REM_MEMORY_RERANK_CANDIDATES",
  rerankTimeoutMs: "REM_MEMORY_RERANK_TIMEOUT_MS",
  rerankCacheMs: "REM_MEMORY_RERANK_CACHE_MS",
  coreSlot: "REM_MEMORY_CORE_SLOT",
  surfaceRefreshMs: "REM_MEMORY_SURFACE_REFRESH_MS",
} as const

export type MemoryConfig = {
  off: boolean
  dream: boolean
  surface: boolean
  summary: boolean
  dir: string
  debug: boolean
  delayMs: number
  maxEntries: number
  maxFacts: number
  maxChars: number
  transcriptChars: number
  sweepIntervalMs: number
  sweepStartMs: number
  sweepBatch: number
  inProgressTimeoutMs: number
  rerank: boolean
  rerankCandidates: number
  rerankTimeoutMs: number
  rerankCacheMs: number
  coreSlot: number
  surfaceRefreshMs: number
}

// Deprecation warnings are emitted at most once per process, however many
// times the configuration is resolved.
let legacyEnvWarned = false
let gcChildAgeWarned = false

export function resetDeprecationWarnings() {
  legacyEnvWarned = false
  gcChildAgeWarned = false
}

function legacyName(key: keyof typeof OPTION_ENV): string {
  return LEGACY_ENV_PREFIX + OPTION_ENV[key].slice(ENV_PREFIX.length)
}

// True when the data directory was chosen by the user (option or either env
// var). Only then is the legacy-directory migration skipped.
export function isDirExplicit(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.hasOwn(options ?? {}, "dir") || env[OPTION_ENV.dir] !== undefined || env[legacyName("dir")] !== undefined
}

export function resolveConfig(
  options: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  home: string = homeDir(env),
): MemoryConfig {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("rem-memory options must be an object")
  }
  for (const key of Object.keys(options)) {
    if (!(key in OPTION_ENV)) throw new Error(`unknown rem-memory option: ${key}`)
  }

  const legacyUsed: string[] = []

  function raw(key: keyof typeof OPTION_ENV): unknown {
    if (Object.hasOwn(options, key)) return options[key]
    if (env[OPTION_ENV[key]] !== undefined) return env[OPTION_ENV[key]]
    const legacy = env[legacyName(key)]
    if (legacy !== undefined) legacyUsed.push(legacyName(key))
    return legacy
  }

  function boolean(key: keyof typeof OPTION_ENV, fallback: boolean): boolean {
    const value = raw(key)
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    if (typeof value === "string" && !Object.hasOwn(options, key)) {
      // Existing environment switches treated every value except "1" as off.
      // Keep that behavior for installations upgrading from 1.7.0.
      if (key === "off" || key === "debug" || key === "rerank") return value === "1"
      if (value === "1") return true
      if (value === "0") return false
    }
    throw new Error(`rem-memory ${key} must be a boolean (environment: 1 or 0)`)
  }

  function integer(key: keyof typeof OPTION_ENV, fallback: number, min: number): number {
    const value = raw(key)
    if (value === undefined) return fallback
    const number = typeof value === "string" && !Object.hasOwn(options, key) && value.trim() !== ""
      ? Number(value) : value
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min) {
      throw new Error(`rem-memory ${key} must be an integer >= ${min}`)
    }
    return number
  }

  const dir = raw("dir") ?? defaultDir(home)
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("rem-memory dir must be a nonempty path")
  const expandedDir = dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir
  if (Object.hasOwn(options, "dir") && !path.isAbsolute(expandedDir)) {
    throw new Error("rem-memory dir option must be an absolute path")
  }

  // gcChildAgeMs belonged to the removed OpenCode V1 adapter: still validated
  // (so existing configs keep working) but ignored.
  if (raw("gcChildAgeMs") !== undefined) {
    integer("gcChildAgeMs", 0, 0)
    if (!gcChildAgeWarned) {
      gcChildAgeWarned = true
      console.warn("[rem-memory] gcChildAgeMs is deprecated and ignored; remove it from your configuration")
    }
  }

  const config: MemoryConfig = {
    off: boolean("off", false),
    dream: boolean("dream", true),
    surface: boolean("surface", true),
    summary: boolean("summary", true),
    dir: path.resolve(expandedDir),
    debug: boolean("debug", false),
    delayMs: integer("delayMs", 90000, 0),
    maxEntries: integer("maxEntries", 400, 1),
    maxFacts: integer("maxFacts", 18, 0),
    maxChars: integer("maxChars", 2400, 1),
    transcriptChars: integer("transcriptChars", 12000, 1),
    sweepIntervalMs: integer("sweepIntervalMs", 10 * 60 * 1000, 1),
    sweepStartMs: integer("sweepStartMs", 20000, 0),
    sweepBatch: integer("sweepBatch", 8, 1),
    inProgressTimeoutMs: integer("inProgressTimeoutMs", 10 * 60 * 1000, 1),
    rerank: boolean("rerank", false),
    rerankCandidates: integer("rerankCandidates", 30, 1),
    rerankTimeoutMs: integer("rerankTimeoutMs", 4000, 1),
    rerankCacheMs: integer("rerankCacheMs", 60 * 1000, 0),
    coreSlot: integer("coreSlot", 3, 0),
    surfaceRefreshMs: integer("surfaceRefreshMs", 15 * 60 * 1000, 0),
  }

  if (legacyUsed.length > 0 && !legacyEnvWarned) {
    legacyEnvWarned = true
    const names = [...new Set(legacyUsed)].map((name) => `${name} -> ${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`)
    console.warn(`[rem-memory] deprecated environment variables in use (rename them): ${names.join(", ")}`)
  }
  return config
}
