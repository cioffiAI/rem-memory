// The native /memory command. commands/memory.md stays the single source of
// truth: it is embedded at build time and forwarded to the model on invocation.

import instructionsFile from "../../commands/memory.md" with { type: "text" }

export const COMMAND_NAME = "memory"
export const COMMAND_DESCRIPTION = "Manage long-term memory (read, remember, update, forget, inspect, resume)"

// Body of the markdown file without its YAML frontmatter.
export function commandInstructions(source: string = instructionsFile): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()
}

export function buildCommandPrompt(args: string, source: string = instructionsFile): string {
  const instructions = commandInstructions(source)
  const request = args.trim()
  return request ? `${instructions}\n\nUser request: ${request}` : instructions
}
