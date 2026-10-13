// DREAM: turn a finished conversation into memory updates. Builds the
// consolidation prompt, asks the host's model, de-duplicates against what is
// already stored, applies the result and keeps the two-phase inProgress
// journal so an interrupted run is retried by the host's recovery sweep.

import { applyConsolidation, consolidationEntries, extractJson, prune, type Entry } from "../core.ts"
import type { EngineDeps } from "./host.ts"

function now() {
  return Date.now()
}

async function dedupCheck(
  { host }: EngineDeps,
  sessionID: string,
  entries: Entry[],
  candidates: { text: string }[],
): Promise<Set<number>> {
  const skip = new Set<number>()
  if (candidates.length === 0 || entries.length === 0) return skip
  const entryLines = entries.map((entry) => `${entry.id} | ${entry.source} | ${entry.category} | ${entry.text}`).join("\n")
  const candidateLines = candidates.map((candidate, index) => `[${index}] ${candidate.text}`).join("\n")
  const prompt = `You are a deduplication checker for a memory store.

EXISTING MEMORY ENTRIES:
${entryLines}

CANDIDATE NEW FACTS:
${candidateLines}

For each candidate that is semantically equivalent to an existing entry (same meaning, ANY language, paraphrase), reply with that candidate's index in "duplicates". An entry with source=explicit always wins over a candidate. Candidates that describe something NEW are not duplicates.

REPLY WITH STRICT JSON ONLY:
{"duplicates":[0,2]}`
  try {
    const answer = await host.generate(prompt, { sessionID, timeoutMs: 90_000 })
    const parsed = extractJson(answer)
    const duplicates = Array.isArray(parsed?.duplicates) ? parsed.duplicates : []
    for (const duplicate of duplicates) {
      const index = Number(duplicate)
      if (Number.isInteger(index) && index >= 0 && index < candidates.length) skip.add(index)
    }
  } catch (error) {
    host.log("debug", "dedup check failed", { error: String(error) })
  }
  return skip
}

export async function consolidate(deps: EngineDeps, sessionID: string) {
  const { host, config, store: storeIO } = deps
  const session = await host.session(sessionID)
  if (!session) return
  const messages = await host.transcript(sessionID)
  const lastTs = messages.reduce((max, message) => Math.max(max, message.time), 0)
  const state = await storeIO.getState()
  if (lastTs <= (state.sessions[sessionID] ?? 0)) return

  const inProgress = state.inProgress?.[sessionID]
  if (inProgress && now() - inProgress.startedAt < config.inProgressTimeoutMs) return

  const transcript = messages
    .map((message) => `${message.type}: ${message.text}`)
    .join("\n\n")
    .slice(-config.transcriptChars)
  const messageIDs = messages.map((message) => String(message.id)).slice(-20)
  const directory = session.directory
  const store = await storeIO.getStore()
  const visible = consolidationEntries(store, directory)
  const entriesBlock =
    visible.length === 0
      ? "(none)"
      : visible
          .map((entry) => `- [${entry.id}] (${entry.scope}/${entry.category}, w=${entry.weight.toFixed(1)}, source=${entry.source}) ${entry.text}`)
          .join("\n")

  const prompt = `You are the memory consolidation module of OpenCode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory. Be concise, third person ("The user...").
2. update: only entries whose fact genuinely CHANGED in the conversation. Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. conflicts: if the conversation STRONGLY contradicts an entry tagged source=explicit, report it with the entry id and a short evidence quote. Never modify or delete that entry.
${config.summary ? "5. summary: 2-5 sentence summary of who the user is and how they like to work. NEVER include sensitive data in the summary." : ""}

SOURCE HIERARCHY:
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed entries.
- NEVER add a new fact semantically equivalent to an explicit entry, in any language or wording.
- A fact about the same user attribute/topic is a duplicate unless it describes a different attribute.
- NEVER delete or update explicit entries; use conflicts instead.
- If a new fact duplicates a dreamed entry, delete the old dreamed id and add the better formulation.
- If a dreamed entry contradicts an explicit one, delete the dreamed entry.

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing is new, return empty arrays${config.summary ? ' but still a summary (or "" if unchanged)' : ''}.
- Write facts in the same language the user used.
- Compare meaning across languages before adding a fact.
- Use scope "project" only for facts tied to this codebase; otherwise use "global".
- Optionally attach confidence (0-1) to each new fact.

RESPOND WITH STRICT JSON ONLY:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project","confidence":0.9}],"update":[{"id":"...","text":"..."}],"delete":["..."],"conflicts":[{"id":"...","evidence":"..."}]${config.summary ? ',"summary":"..."' : ''}}

CURRENT MEMORY ENTRIES:
${entriesBlock}

TRANSCRIPT (session title: ${session.title ?? ""}):
${transcript}`

  state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
  await storeIO.saveState(state)
  let completed = false
  try {
    const answer = await host.generate(prompt, { sessionID, timeoutMs: 120_000 })
    if (!answer) throw new Error("consolidation timed out")
    const parsed = extractJson(answer)
    if (!parsed || !Array.isArray(parsed.new)) throw new Error("consolidation returned no usable JSON")
    if (!config.summary) delete parsed.summary

    if (parsed.new.length > 0 && visible.length > 0) {
      const skip = await dedupCheck(deps, sessionID, visible, parsed.new)
      parsed.new = parsed.new.filter((_: unknown, index: number) => !skip.has(index))
    }

    await storeIO.withLock(async () => {
      const fresh = await storeIO.getStore()
      applyConsolidation(fresh, parsed, directory, now(), host.log.bind(host), {
        sessionID,
        messageIDs,
      })
      prune(fresh, now(), config.maxEntries)
      await storeIO.writeStore(fresh)
    })
    state.sessions[sessionID] = lastTs
    completed = true
    host.log("info", "consolidated session", { sessionID, newFacts: parsed.new.length })
  } finally {
    if (completed) delete state.inProgress![sessionID]
    else state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
    await storeIO.saveState(state).catch(() => {})
  }
}
