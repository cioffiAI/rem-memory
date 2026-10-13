// The git worktree root of a project directory: the nearest ancestor holding a
// `.git` entry (a directory, or a file in linked worktrees and submodules).
// OpenCode reports snapshot and vcs paths relative to it. Falls back to the
// directory itself outside git.

import { stat } from "node:fs/promises"
import path from "node:path"

export async function worktreeRoot(directory: string): Promise<string> {
  let current = path.resolve(directory)
  for (;;) {
    if (await stat(path.join(current, ".git")).then(() => true, () => false)) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(directory)
    current = parent
  }
}
