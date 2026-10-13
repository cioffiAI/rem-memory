// The boundary between the memory engine and whatever agent hosts it. The
// engine (dream, surface, tools) only talks to this interface; adapters under
// src/hosts implement it.

import type { LogLevel } from "../core.ts"
import type { MemoryConfig } from "../config.ts"
import type { StoreIO } from "../store.ts"

export type { LogLevel }

// A host-neutral view of one conversation message. `text` is exactly what the
// DREAM transcript has always used (tool parts appear there as "[tool]");
// `tools` and `snapshotFiles` carry what that text drops.
export type TranscriptMessage = {
  id: string
  type: string
  text: string
  time: number
  tools?: { name: string; input: Record<string, unknown> }[]
  snapshotFiles?: string[]
}

export type ChangedFile = { file: string; status: string; additions?: number; deletions?: number }

export type SessionRef = { directory: string; title?: string }

export interface Host {
  readonly name: "opencode"
  // Undefined when the session cannot be resolved at all.
  session(sessionID: string): Promise<SessionRef | undefined>
  // Falls back to the host's own directory when the session is unknown.
  directoryFor(sessionID: string): Promise<string | undefined>
  // Resolves "" when the call times out or is aborted; rejects on real errors.
  generate(prompt: string, opts: { sessionID?: string; timeoutMs: number }): Promise<string>
  transcript(sessionID: string): Promise<TranscriptMessage[]>
  lastUserText(sessionID: string): Promise<string>
  vcs?(directory: string): Promise<{ branch?: string; changed: ChangedFile[] } | undefined>
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void
}

export type EngineDeps = { host: Host; config: MemoryConfig; store: StoreIO }
