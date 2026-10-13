// Pure helpers over TranscriptMessage. No host or filesystem access.

import path from "path"
import type { TranscriptMessage } from "./host.ts"

// Project-relative posix path, or undefined when it lies outside the project.
// Relative input is resolved against `base` (the project by default; the git
// worktree root for paths OpenCode reports relative to it).
export function toProjectPath(raw: unknown, projectDir: string, base = projectDir): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  const root = path.resolve(projectDir)
  const relative = path.relative(root, path.resolve(base, raw.trim()))
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
// primary source (covers edit/write/patch/shell inside git); its paths are
// relative to the git worktree root, which differs from the project when the
// project is a subdirectory of the repository. edit/write/patch tool inputs
// (relative to the project) fill the gap outside git. Result is deduplicated
// and project-relative; files outside the project are dropped.
export function touchedFiles(messages: TranscriptMessage[], projectDir: string, worktreeRoot = projectDir): string[] {
  const found = new Set<string>()
  const add = (raw: unknown, base = projectDir) => {
    const normalized = toProjectPath(raw, projectDir, base)
    if (normalized) found.add(normalized)
  }
  for (const message of messages) {
    for (const file of message.snapshotFiles ?? []) add(file, worktreeRoot)
    for (const tool of message.tools ?? []) {
      if (tool.name === "edit" || tool.name === "write") add(tool.input.path)
      else if (tool.name === "patch") for (const file of patchPaths(tool.input.patchText)) add(file)
    }
  }
  return [...found]
}
