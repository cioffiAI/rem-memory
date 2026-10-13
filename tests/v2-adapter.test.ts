import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function runV2Check(extraEnv: Record<string, string> = {}) {
  const memoryDir = mkdtempSync(join(tmpdir(), "rem-memory-v2-test-"))
  try {
    const result = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "fixtures", "v2-check.ts")],
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        REM_MEMORY_DIR: memoryDir,
        REM_MEMORY_DREAM: "1",
        REM_MEMORY_SURFACE: "1",
        REM_MEMORY_SUMMARY: "1",
        REM_MEMORY_DELAY_MS: "0",
        REM_MEMORY_SWEEP_START_MS: "600000",
        REM_MEMORY_SWEEP_MS: "600000",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0)
    expect(result.stdout.toString()).toContain("V2_CHECK_OK")
  } finally {
    rmSync(memoryDir, { recursive: true, force: true })
  }
}

for (const event of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]) {
  test(`V2 adapter DREAMs on ${event}, injects context and preserves local-only privacy`, () => {
    runV2Check({ V2_CHECK_EVENT: event })
  })
}

test("V2 recovery pass retries a stale interrupted DREAM", () => {
  runV2Check({ V2_CHECK_SWEEP_ONLY: "1", REM_MEMORY_SWEEP_START_MS: "0" })
})

test("V2 setup rolls back tool registration if context hook registration fails", () => {
  runV2Check({ V2_CHECK_FAIL_SETUP: "1" })
})

test("V2 can disable DREAM while keeping explicit tools and SURFACE", () => {
  runV2Check({ REM_MEMORY_DREAM: "0", V2_CHECK_DREAM_DISABLED: "1" })
})

test("V2 DREAM omits a disabled summary and ignores an unsolicited model summary", () => {
  runV2Check({ REM_MEMORY_SUMMARY: "0" })
})

test("V2 can disable SURFACE while keeping DREAM and explicit tools", () => {
  runV2Check({ REM_MEMORY_SURFACE: "0", V2_CHECK_SURFACE_DISABLED: "1" })
})

test("V2 can disable both automatic processes", () => {
  runV2Check({
    REM_MEMORY_DREAM: "0", REM_MEMORY_SURFACE: "0",
    V2_CHECK_DREAM_DISABLED: "1", V2_CHECK_SURFACE_DISABLED: "1",
  })
})

test("V2 completion event writes the mechanical handoff immediately", () => {
  runV2Check({ V2_CHECK_HANDOFF: "1" })
})

test("V2 writes the handoff even with DREAM disabled", () => {
  runV2Check({ V2_CHECK_HANDOFF: "1", REM_MEMORY_DREAM: "0", V2_CHECK_DREAM_DISABLED: "1" })
})

test("V2 writes no handoff when handoff is disabled", () => {
  runV2Check({ V2_CHECK_SNAPSHOT: "1", REM_MEMORY_HANDOFF: "0" })
})
