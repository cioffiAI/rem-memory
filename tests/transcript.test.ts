import { describe, expect, test } from "bun:test"
import type { TranscriptMessage } from "../src/engine/host.ts"
import { touchedFiles } from "../src/engine/transcript.ts"

const project = "/work/app"

function assistant(extra: Partial<TranscriptMessage>): TranscriptMessage {
  return { id: "m", type: "assistant", text: "", time: 1, ...extra }
}

describe("touchedFiles", () => {
  test("uses snapshot files as the primary source", () => {
    expect(touchedFiles([assistant({ snapshotFiles: ["a.txt", "src/b.ts"] })], project)).toEqual(["a.txt", "src/b.ts"])
  })

  test("falls back to edit/write input.path, relative or absolute", () => {
    const messages = [assistant({
      tools: [
        { name: "edit", input: { path: "/work/app/src/a.ts", oldString: "x", newString: "y" } },
        { name: "write", input: { path: "docs/c.md", content: "..." } },
        { name: "write", input: { path: "./docs/d.md" } },
        { name: "shell", input: { command: "echo hi >> e.txt" } },
      ],
    })]
    expect(touchedFiles(messages, project)).toEqual(["src/a.ts", "docs/c.md", "docs/d.md"])
  })

  test("parses paths from patchText", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: d.txt",
      "+hello",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-a",
      "+b",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n")
    expect(touchedFiles([assistant({ tools: [{ name: "patch", input: { patchText } }] })], project)).toEqual([
      "d.txt",
      "src/old.ts",
      "src/new.ts",
      "gone.txt",
    ])
  })

  test("drops paths outside the project", () => {
    const messages = [assistant({
      snapshotFiles: ["../secret.txt", "ok.txt"],
      tools: [
        { name: "edit", input: { path: "/etc/passwd" } },
        { name: "edit", input: { path: "/work/app-other/x.ts" } },
        { name: "write", input: { path: "src/../../escape.ts" } },
        { name: "write", input: { path: "src/../inside.ts" } },
        { name: "edit", input: { path: "/work/app" } },
        { name: "edit", input: {} },
      ],
    })]
    expect(touchedFiles(messages, project)).toEqual(["ok.txt", "inside.ts"])
  })

  test("deduplicates across sources and messages", () => {
    const messages = [
      assistant({ snapshotFiles: ["a.txt"], tools: [{ name: "edit", input: { path: "/work/app/a.txt" } }] }),
      assistant({ tools: [{ name: "write", input: { path: "a.txt" } }] }),
    ]
    expect(touchedFiles(messages, project)).toEqual(["a.txt"])
  })
})

describe("touchedFiles in a project that is a subdirectory of the repository", () => {
  const repo = "/work"
  test("snapshot paths are relative to the worktree root, tool paths to the project", () => {
    const messages = [
      assistant({ snapshotFiles: ["app/src/a.ts", "other/b.ts", "README.md"] }),
      assistant({ tools: [{ name: "edit", input: { path: "src/c.ts" } }] }),
    ]
    expect(touchedFiles(messages, project, repo)).toEqual(["src/a.ts", "src/c.ts"])
  })
})
