// HANDOFF: a "where we left off" note per session. A mechanical layer (no LLM)
// is written the moment a session completes; DREAM may enrich it with a short
// narrative. SURFACE hands it to the next session of the same project once,
// on its first request. Everything is derived from the transcript (same
// exposure as the summary) and never contains local-only entries.

import type { Handoff, Store } from "../core.ts"
import type { EngineDeps, Host, TranscriptMessage } from "./host.ts"
import { touchedFiles } from "./transcript.ts"

export type Narrative = NonNullable<Handoff["narrative"]>

const HOUR = 60 * 60 * 1000
const REQUEST_CHARS = 300
const FILES_MAX = 20
const FILES_LISTED = 10
const GOAL_CHARS = 300
const ITEM_CHARS = 200
const ITEMS_MAX = 5
const GLOBAL_CAP = 50

export const HANDOFF_INSTRUCTION =
  "The previous session in this project ended as follows. Mention it only if the user's request relates to it; do not assume they want to continue."

function now() {
  return Date.now()
}

function oneLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function items(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => oneLine(item, ITEM_CHARS)).filter(Boolean).slice(0, ITEMS_MAX)
}

// Validates the model's `handoff` answer. Undefined when it carries nothing.
export function parseNarrative(value: unknown): Narrative | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const narrative: Narrative = {
    goal: oneLine(raw.goal, GOAL_CHARS),
    state: oneLine(raw.state, GOAL_CHARS),
    next: items(raw.next),
    openQuestions: items(raw.openQuestions),
  }
  const empty = !narrative.goal && !narrative.state && narrative.next.length === 0 && narrative.openQuestions.length === 0
  return empty ? undefined : narrative
}

function fileStatus(status: string | undefined): "added" | "modified" | "deleted" {
  const value = (status ?? "").toLowerCase()
  if (value === "added" || value === "untracked" || value === "new") return "added"
  if (value === "deleted" || value === "removed") return "deleted"
  return "modified"
}

// Keep the newest `keep` handoffs per project, then the newest GLOBAL_CAP overall.
export function pruneHandoffs(store: Store, keep: number, cap = GLOBAL_CAP) {
  const perProject = new Map<string, number>()
  const kept: Handoff[] = []
  for (const handoff of [...store.handoffs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const count = perProject.get(handoff.projectID) ?? 0
    if (count >= keep) continue
    perProject.set(handoff.projectID, count + 1)
    kept.push(handoff)
  }
  store.handoffs = kept.slice(0, cap)
}

export function projectHandoffs(store: Store, projectID: string | undefined): Handoff[] {
  if (!projectID) return []
  return store.handoffs.filter((handoff) => handoff.projectID === projectID).sort((a, b) => b.updatedAt - a.updatedAt)
}

// memory_clear(scope="project"): only this project's handoffs. Returns the removed count.
export function clearProjectHandoffs(store: Store, projectID: string | undefined): number {
  const before = store.handoffs.length
  store.handoffs = store.handoffs.filter((handoff) => !(!!projectID && handoff.projectID === projectID))
  return before - store.handoffs.length
}

// Latest handoff the next session may be told about: same project (exact
// directory), another session, not dismissed, not older than maxAgeHours.
export function surfaceCandidate(store: Store, projectID: string | undefined, sessionID: string, maxAgeHours: number, time = now()): Handoff | undefined {
  return projectHandoffs(store, projectID).find(
    (handoff) => handoff.sessionID !== sessionID && !handoff.dismissedAt && time - handoff.updatedAt <= maxAgeHours * HOUR,
  )
}

export function relativeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function renderFiles(handoff: Handoff, listed: number): string | undefined {
  if (handoff.files.length === 0) return undefined
  const shown = handoff.files.slice(0, listed).map((file) => `${file.path} (${file.status})`)
  const extra = handoff.files.length - shown.length
  return `Files: ${shown.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`
}

function bodyLines(handoff: Handoff, listed: number): string[] {
  const lines: string[] = []
  if (handoff.request) lines.push(`Request: ${handoff.request}`)
  const narrative = handoff.narrative
  if (narrative?.goal) lines.push(`Goal: ${narrative.goal}`)
  if (narrative?.state) lines.push(`State: ${narrative.state}`)
  if (narrative?.next.length) lines.push("Next:", ...narrative.next.map((item) => `- ${item}`))
  if (narrative?.openQuestions.length) lines.push("Open questions:", ...narrative.openQuestions.map((item) => `- ${item}`))
  const files = renderFiles(handoff, listed)
  if (files) lines.push(files)
  return lines
}

// The <handoff> block injected into the model context, capped at maxChars
// (closing tag included).
export function renderSurfaceHandoff(handoff: Handoff, opts: { time?: number; currentBranch?: string; maxChars: number }): string {
  const time = opts.time ?? now()
  const branchNote = handoff.branch && opts.currentBranch && handoff.branch !== opts.currentBranch ? ` (written on branch ${handoff.branch})` : ""
  const lines = [HANDOFF_INSTRUCTION, `Ended ${relativeAge(time - handoff.updatedAt)}${branchNote}.`, ...bodyLines(handoff, FILES_LISTED)]
  // A stray closing tag in transcript-derived text must not end the block early.
  let body = lines.join("\n").replace(/<\/(handoff|memory)>/gi, "<\\/$1>")
  const open = "<handoff>\n"
  const close = "\n</handoff>"
  const room = Math.max(0, opts.maxChars - open.length - close.length)
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1))}…`
  return `${open}${body}${close}`
}

// Full, uncapped view for memory_handoff.
export function renderToolHandoff(handoff: Handoff, time = now()): string {
  const flags = `${handoff.level}${handoff.dismissedAt ? ", dismissed" : ""}`
  const lines = [`Handoff [${handoff.id}] (${flags}) from session ${handoff.sessionID}, ${relativeAge(time - handoff.updatedAt)}${handoff.branch ? `, branch ${handoff.branch}` : ""}`]
  lines.push(...bodyLines(handoff, FILES_MAX))
  return lines.join("\n")
}

export function listLine(handoff: Handoff, time = now()): string {
  return `- [${handoff.id}] ${relativeAge(time - handoff.updatedAt)}, ${handoff.level}${handoff.dismissedAt ? ", dismissed" : ""}: ${handoff.request ?? "(no request recorded)"}`
}

// First request of a session = exactly one user message in its transcript.
export async function isFirstRequest(host: Host, sessionID: string): Promise<boolean> {
  try {
    return (await host.transcript(sessionID)).filter((message) => message.type === "user").length === 1
  } catch {
    return false
  }
}

async function snapshot(host: Host, sessionID: string, directory: string, messages: TranscriptMessage[]) {
  const paths = touchedFiles(messages, directory).slice(0, FILES_MAX)
  const info = host.vcs ? await host.vcs(directory).catch(() => undefined) : undefined
  const status = new Map((info?.changed ?? []).map((file) => [file.file, file.status]))
  const request = oneLine(await host.lastUserText(sessionID).catch(() => ""), REQUEST_CHARS)
  return {
    files: paths.map((path) => ({ path, status: fileStatus(status.get(path)) })),
    branch: info?.branch || undefined,
    request: request || undefined,
  }
}

// Creates or refreshes this session's handoff (one per session). Without a
// narrative it is the mechanical layer: sessions that touched no files and
// have no enriched handoff yet are trivial and leave nothing behind. With a
// narrative (from DREAM) it creates the handoff if missing and enriches it.
export async function recordHandoff(
  { host, config, store: storeIO }: EngineDeps,
  sessionID: string,
  opts: { narrative?: Narrative; messages?: TranscriptMessage[]; directory?: string } = {},
): Promise<void> {
  if (!config.handoff) return
  const directory = opts.directory ?? (await host.session(sessionID))?.directory
  if (!directory) return
  const messages = opts.messages ?? (await host.transcript(sessionID))
  const snap = await snapshot(host, sessionID, directory, messages)
  const time = now()
  await storeIO.withLock(async () => {
    const store = await storeIO.getStore()
    const existing = store.handoffs.find((handoff) => handoff.sessionID === sessionID)
    if (!opts.narrative && snap.files.length === 0 && existing?.level !== "enriched") return
    const handoff: Handoff = existing ?? {
      id: crypto.randomUUID(),
      projectID: directory,
      sessionID,
      origin: { host: host.name },
      createdAt: time,
      updatedAt: time,
      files: [],
      level: "mechanical",
    }
    handoff.updatedAt = time
    handoff.files = snap.files
    handoff.branch = snap.branch
    handoff.request = snap.request
    if (opts.narrative) {
      handoff.narrative = opts.narrative
      handoff.level = "enriched"
    }
    if (!existing) store.handoffs.push(handoff)
    pruneHandoffs(store, config.handoffKeep)
    store.updatedAt = time
    await storeIO.writeStore(store)
  })
}

export function writeMechanicalHandoff(deps: EngineDeps, sessionID: string) {
  return recordHandoff(deps, sessionID)
}

// DREAM answered `"handoff": null`: trivial session. Drop its handoff unless
// it recorded touched files (those are still worth handing over).
export async function dropTrivialHandoff({ config, store: storeIO }: EngineDeps, sessionID: string): Promise<void> {
  if (!config.handoff) return
  await storeIO.withLock(async () => {
    const store = await storeIO.getStore()
    const existing = store.handoffs.find((handoff) => handoff.sessionID === sessionID)
    if (!existing || existing.files.length > 0) return
    store.handoffs = store.handoffs.filter((handoff) => handoff !== existing)
    store.updatedAt = now()
    await storeIO.writeStore(store)
  })
}
