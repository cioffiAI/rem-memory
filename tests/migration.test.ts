import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"
import { defaultDir, legacyDir } from "../src/config.ts"
import { MIGRATION_MARKER, migrateLegacyStore } from "../src/store.ts"

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "memory-migration-"))
  return { home, oldDir: legacyDir(home), newDir: defaultDir(home) }
}

function seedLegacy(oldDir: string) {
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, "store.json"), '{"version":2,"summary":"","updatedAt":0,"entries":[]}')
  writeFileSync(join(oldDir, "state.json"), '{"sessions":{"s":1}}')
  writeFileSync(join(oldDir, "SUMMARY.md"), "# old summary\n")
}

test("migration copies the store files and leaves a marker in the old directory", async () => {
  const { home, oldDir, newDir } = fakeHome()
  try {
    seedLegacy(oldDir)
    expect(await migrateLegacyStore(newDir, home)).toBe(true)
    for (const name of ["store.json", "state.json", "SUMMARY.md"]) {
      expect(readFileSync(join(newDir, name), "utf8")).toBe(readFileSync(join(oldDir, name), "utf8"))
    }
    const marker = readFileSync(join(oldDir, MIGRATION_MARKER), "utf8")
    expect(marker).toContain(newDir)
    expect(marker).toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(readFileSync(join(oldDir, "store.json"), "utf8")).toBe('{"version":2,"summary":"","updatedAt":0,"entries":[]}')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("migration copies only the files that exist", async () => {
  const { home, oldDir, newDir } = fakeHome()
  try {
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, "store.json"), "{}")
    expect(await migrateLegacyStore(newDir, home)).toBe(true)
    expect(existsSync(join(newDir, "state.json"))).toBe(false)
    expect(existsSync(join(newDir, "SUMMARY.md"))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a new directory that already has a store is never overwritten", async () => {
  const { home, oldDir, newDir } = fakeHome()
  try {
    seedLegacy(oldDir)
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, "store.json"), '{"mine":true}')
    expect(await migrateLegacyStore(newDir, home)).toBe(false)
    expect(readFileSync(join(newDir, "store.json"), "utf8")).toBe('{"mine":true}')
    expect(existsSync(join(oldDir, MIGRATION_MARKER))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a missing old directory migrates nothing", async () => {
  const { home, oldDir, newDir } = fakeHome()
  try {
    expect(await migrateLegacyStore(newDir, home)).toBe(false)
    expect(existsSync(newDir)).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function context(options: Record<string, unknown>) {
  const tools: any[] = []
  return {
    options: { dream: false, surface: false, ...options },
    location: { directory: "/project" },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.push(tool) })
        return { dispose: async () => {} }
      },
      list: async () => tools.map((tool) => ({ id: tool.name })),
    },
    session: { hook: async () => ({ dispose: async () => {} }), get: async () => ({}), context: async () => [] },
  } as any
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

test("plugin setup migrates when no dir is configured", async () => {
  const { home, oldDir, newDir } = fakeHome()
  try {
    seedLegacy(oldDir)
    await withHome(home, async () => {
      const cleanup = await plugin.setup(context({}))
      await cleanup?.()
    })
    expect(existsSync(join(newDir, "store.json"))).toBe(true)
    expect(existsSync(join(oldDir, MIGRATION_MARKER))).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("plugin setup with an explicit dir option does not migrate", async () => {
  const { home, oldDir, newDir } = fakeHome()
  const explicit = join(home, "explicit")
  try {
    seedLegacy(oldDir)
    await withHome(home, async () => {
      const cleanup = await plugin.setup(context({ dir: explicit }))
      await cleanup?.()
    })
    expect(existsSync(join(explicit, "store.json"))).toBe(false)
    expect(existsSync(newDir)).toBe(false)
    expect(existsSync(join(oldDir, MIGRATION_MARKER))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
