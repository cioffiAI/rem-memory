// Code anchors: tie a project fact to a file (and optionally a symbol) and
// derive, on demand, whether that code still looks the way it did. State is
// never persisted. This is the only engine module besides the host adapters
// that touches the filesystem; core.ts stays pure.
//
// Safety rule: a path is only ever read after realpath() proves it lies inside
// realpath(projectDir). Traversal, absolute paths and symlinks that escape the
// project are rejected.

import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { Anchor, Entry } from "../core.ts"

export type AnchorState = "fresh" | "drifted" | "broken"
export type AnchorCheck = { anchor: Anchor; state: AnchorState; reason: string }
export type EntryAnchorState = { state: AnchorState; checks: AnchorCheck[] }

export const MAX_ANCHORS = 3
// Above this size we hash "size:mtime" instead of reading the whole file.
export const HASH_CONTENT_LIMIT = 1024 * 1024
// Above this size the symbol check is skipped (assumed present).
const SYMBOL_SCAN_LIMIT = 8 * 1024 * 1024
const CACHE_LIMIT = 500

export class AnchorError extends Error {
  constructor(
    readonly code: "invalid" | "outside" | "missing" | "symbol",
    message: string,
  ) {
    super(message)
  }
}

type FileInfo = { hash: string; symbols: Map<string, boolean> }
// Keyed by (absolute real path, mtimeMs, size): any edit changes the key.
export type AnchorCache = Map<string, FileInfo>

export function createAnchorCache(): AnchorCache {
  return new Map()
}

export function anchorLabel(anchor: Pick<Anchor, "path" | "symbol">): string {
  return anchor.symbol ? `${anchor.path}#${anchor.symbol}` : anchor.path
}

export function parseAnchorSpec(spec: string): { path: string; symbol?: string } {
  if (typeof spec !== "string" || !spec.trim()) throw new AnchorError("invalid", "Anchor is empty.")
  const raw = spec.trim()
  const hash = raw.indexOf("#")
  const rawPath = (hash === -1 ? raw : raw.slice(0, hash)).trim()
  const symbol = hash === -1 ? undefined : raw.slice(hash + 1).trim()
  if (!rawPath) throw new AnchorError("invalid", `Anchor "${raw}" has no file path.`)
  if (rawPath.includes("\0")) throw new AnchorError("invalid", `Anchor "${raw}" has an invalid path.`)
  if (rawPath.startsWith("/") || path.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
    throw new AnchorError("invalid", `Anchor "${raw}" must be a path relative to the project, not absolute.`)
  }
  const normalized = path.posix.normalize(rawPath.split(path.sep).join("/"))
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new AnchorError("invalid", `Anchor "${raw}" points outside the project.`)
  }
  if (symbol !== undefined && (!symbol || /\s/.test(symbol) || symbol.length > 200)) {
    throw new AnchorError("invalid", `Anchor "${raw}" has an invalid symbol (use path#identifier, no spaces).`)
  }
  return symbol === undefined ? { path: normalized } : { path: normalized, symbol }
}

// Real absolute path of `relPath`, guaranteed to be inside the project.
export async function resolveInside(projectDir: string, relPath: string): Promise<string> {
  const root = await realpath(projectDir).catch(() => {
    throw new AnchorError("missing", "The project directory is not available.")
  })
  const lexical = path.resolve(projectDir, relPath)
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate)
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  const lexicalRelative = path.relative(path.resolve(projectDir), lexical)
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new AnchorError("outside", `${relPath} is outside the project.`)
  }
  let real: string
  try {
    real = await realpath(lexical)
  } catch {
    throw new AnchorError("missing", `${relPath} does not exist.`)
  }
  if (!inside(real)) throw new AnchorError("outside", `${relPath} is outside the project.`)
  return real
}

async function inspectFile(relPath: string, projectDir: string, cache: AnchorCache): Promise<{ real: string; info: FileInfo }> {
  const real = await resolveInside(projectDir, relPath)
  const stats = await stat(real).catch(() => undefined)
  if (!stats || !stats.isFile()) throw new AnchorError("missing", `${relPath} is not a readable file.`)
  const key = `${real}|${stats.mtimeMs}|${stats.size}`
  let info = cache.get(key)
  if (!info) {
    let hash: string
    if (stats.size > HASH_CONTENT_LIMIT) hash = `${stats.size}:${stats.mtimeMs}`
    else {
      const content = await readFile(real).catch(() => {
        throw new AnchorError("missing", `${relPath} is not a readable file.`)
      })
      hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
    }
    info = { hash, symbols: new Map() }
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, info)
  }
  return { real, info }
}

function symbolRegex(symbol: string) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")
  // \b fails next to "$", so use explicit identifier-character lookarounds.
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`)
}

async function hasSymbol(real: string, info: FileInfo, symbol: string): Promise<boolean> {
  const known = info.symbols.get(symbol)
  if (known !== undefined) return known
  const stats = await stat(real).catch(() => undefined)
  let present = true
  if (stats && stats.size <= SYMBOL_SCAN_LIMIT) {
    const text = await readFile(real, "utf8").catch(() => undefined)
    present = text === undefined ? false : symbolRegex(symbol).test(text)
  }
  info.symbols.set(symbol, present)
  return present
}

export async function createAnchor(spec: string, projectDir: string, now: number, cache: AnchorCache = createAnchorCache()): Promise<Anchor> {
  const parsed = parseAnchorSpec(spec)
  const { real, info } = await inspectFile(parsed.path, projectDir, cache)
  if (parsed.symbol && !(await hasSymbol(real, info, parsed.symbol))) {
    throw new AnchorError("symbol", `Symbol "${parsed.symbol}" was not found in ${parsed.path}.`)
  }
  return { path: parsed.path, ...(parsed.symbol ? { symbol: parsed.symbol } : {}), hash: info.hash, anchoredAt: now }
}

// Parse a user/model-supplied list into anchors. Throws a readable AnchorError.
export async function createAnchors(specs: unknown, projectDir: string, now: number, cache?: AnchorCache): Promise<Anchor[]> {
  if (!Array.isArray(specs) || specs.some((spec) => typeof spec !== "string")) {
    throw new AnchorError("invalid", 'anchors must be an array of strings like "src/x.ts" or "src/x.ts#symbol".')
  }
  if (specs.length > MAX_ANCHORS) throw new AnchorError("invalid", `An entry can have at most ${MAX_ANCHORS} anchors.`)
  const anchors: Anchor[] = []
  for (const spec of specs) anchors.push(await createAnchor(spec, projectDir, now, cache))
  return anchors
}

export async function anchorState(anchor: Anchor, projectDir: string, cache: AnchorCache): Promise<AnchorCheck> {
  let file: { real: string; info: FileInfo }
  try {
    file = await inspectFile(anchor.path, projectDir, cache)
  } catch (error) {
    if (error instanceof AnchorError && error.code === "outside") return { anchor, state: "broken", reason: "outside project" }
    return { anchor, state: "broken", reason: "file missing" }
  }
  if (file.info.hash === anchor.hash) return { anchor, state: "fresh", reason: "unchanged" }
  if (anchor.symbol) {
    return (await hasSymbol(file.real, file.info, anchor.symbol))
      ? { anchor, state: "drifted", reason: "file changed" }
      : { anchor, state: "broken", reason: "symbol missing" }
  }
  return { anchor, state: "drifted", reason: "file changed" }
}

const SEVERITY: Record<AnchorState, number> = { fresh: 0, drifted: 1, broken: 2 }

// Worst state among the entry's anchors. Entries without anchors are fresh.
// Anchors only mean something for project entries, whose projectID is the
// directory the paths are relative to.
export async function entryAnchorState(entry: Entry, cache: AnchorCache): Promise<EntryAnchorState> {
  const anchors = entry.anchors
  if (!anchors?.length) return { state: "fresh", checks: [] }
  const checks: AnchorCheck[] = []
  for (const anchor of anchors) {
    if (entry.scope !== "project" || !entry.projectID) checks.push({ anchor, state: "broken", reason: "no project" })
    else checks.push(await anchorState(anchor, entry.projectID, cache))
  }
  const state = checks.reduce<AnchorState>((worst, check) => (SEVERITY[check.state] > SEVERITY[worst] ? check.state : worst), "fresh")
  return { state, checks }
}

export function describeCheck(check: AnchorCheck): string {
  return `${anchorLabel(check.anchor)} ${check.reason}`
}

// Recompute hashes of existing anchors (reconfirmation). An anchor whose file
// or symbol can no longer be resolved keeps its old hash and stays stale.
export async function refreshAnchors(anchors: Anchor[] | undefined, projectDir: string | undefined, now: number, cache?: AnchorCache): Promise<Anchor[] | undefined> {
  if (!anchors?.length || !projectDir) return anchors
  const refreshed: Anchor[] = []
  for (const anchor of anchors) {
    try {
      refreshed.push(await createAnchor(anchorLabel(anchor), projectDir, now, cache))
    } catch {
      refreshed.push(anchor)
    }
  }
  return refreshed
}
