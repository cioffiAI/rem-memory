// Pure helpers over TranscriptMessage. No host or filesystem access.

import path from "path"
import type { TranscriptMessage } from "./host.ts"

// Project-relative posix path, or undefined when it lies outside the project.
function toProjectPath(raw: unknown, projectDir: string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  const root = path.resolve(projectDir)
  const relative = path.relative(root, path.resolve(root, raw.trim()))
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/")
}

// "*** Add File: d.txt", "*** Update File: ...", "*** Delete File: ...", "*** Move to: ..."
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

function patchPaths(patchText: unknown): string[] {
  if (typeof patchText !== "string") return []
  return [...patchText.matchAll(PATCH_PATH)].map((match) => match[1].trim())
}

// Files touched during a session. The assistant `snapshot.files` list is the
// primary source (covers edit/write/patch/shell inside git); edit/write/patch
// tool inputs fill the gap outside git. Result is deduplicated, project-relative.
export function touchedFiles(messages: TranscriptMessage[], projectDir: string): string[] {
  const found = new Set<string>()
  const add = (raw: unknown) => {
    const normalized = toProjectPath(raw, projectDir)
    if (normalized) found.add(normalized)
  }
  for (const message of messages) {
    for (const file of message.snapshotFiles ?? []) add(file)
    for (const tool of message.tools ?? []) {
      if (tool.name === "edit" || tool.name === "write") add(tool.input.path)
      else if (tool.name === "patch") for (const file of patchPaths(tool.input.patchText)) add(file)
    }
  }
  return [...found]
}
