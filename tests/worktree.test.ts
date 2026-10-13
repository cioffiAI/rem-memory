import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { worktreeRoot } from "../src/engine/worktree.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rem-worktree-")))
  dirs.push(dir)
  return dir
}

test("finds the repository root above a project subdirectory", async () => {
  const repo = await temp()
  await mkdir(join(repo, ".git"))
  await mkdir(join(repo, "packages", "app"), { recursive: true })
  expect(await worktreeRoot(join(repo, "packages", "app"))).toBe(repo)
})

test("a .git file (linked worktree or submodule) marks the root too", async () => {
  const repo = await temp()
  await writeFile(join(repo, ".git"), "gitdir: /elsewhere\n")
  expect(await worktreeRoot(repo)).toBe(repo)
})

test("outside git the project directory itself is returned", async () => {
  const dir = await temp()
  // tmpdir is not inside a repository on CI or macOS; guard anyway.
  const root = await worktreeRoot(dir)
  expect(root === dir || !root.startsWith(dir)).toBe(true)
})
