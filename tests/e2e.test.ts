// End-to-end test against a live OpenCode server.
//
// This test is skipped by default because it requires a running server with
// the plugin enabled in a dedicated memory dir. To run it:
//
//   export REM_MEMORY_E2E_URL=http://127.0.0.1:4601
//   bun test tests/e2e.test.ts
//
// Server setup (run in another terminal, inside this repo):
//
//   REM_MEMORY_DIR=/tmp/opencode-e2e-memory \
//     REM_MEMORY_DEBUG=1 \
//     REM_MEMORY_DELAY_MS=3000 \
//     OPENCODE_CONFIG=/tmp/opencode-e2e-config/opencode.jsonc \
//     opencode serve --port 4601
//
// with /tmp/opencode-e2e-config/opencode.jsonc containing:
//
//   { "plugin": ["/abs/path/to/rem-memory"] }
//
// The test drives the session API directly and then verifies that the memory
// store and state file were produced on disk.

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const E2E_URL = process.env.REM_MEMORY_E2E_URL
const E2E_MEMORY_DIR = process.env.REM_MEMORY_DIR ?? join(homedir(), ".local", "share", "rem-memory")

const skip = !E2E_URL ? "set REM_MEMORY_E2E_URL to run the live server test" : undefined

describe("e2e (live server)", () => {
  test.skipIf(!!skip)("creates a session and answers through the plugin", async () => {

    const res = await fetch(`${E2E_URL}/session`, { method: "POST" })
    expect(res.ok).toBe(true)
    const { sessionID } = (await res.json()) as { sessionID: string }
    expect(sessionID).toBeTruthy()

    const prompt = await fetch(`${E2E_URL}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Reply with exactly: PLUGIN_OK",
        model: "gpt-4o",
      }),
    })
    expect(prompt.ok).toBe(true)
  }, 120_000)

  test.skipIf(!!skip)("persists a memory store and a state file on disk", async () => {

    const storePath = join(E2E_MEMORY_DIR, "store.json")
    const statePath = join(E2E_MEMORY_DIR, "state.json")

    for (let i = 0; i < 30 && !existsSync(storePath); i++) {
      await Bun.sleep(2000)
    }

    expect(existsSync(storePath)).toBe(true)
    expect(existsSync(statePath)).toBe(true)
  }, 90_000)
})
