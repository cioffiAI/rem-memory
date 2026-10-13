# Spike OpenCode V2 (PR 0)

Binary: `~/.opencode/bin/opencode` -> `v2.0.18`. `~/.opencode/bin/opencode2` is only a 2-line sh wrapper
(`exec "$(dirname "$0")/opencode" "$@"`), so it reports `v2.0.18` too (same binary).
Method: real `opencode serve` with isolated XDG/HOME dirs, localhost deterministic model (copy of repo mock), throwaway plugin
`plugin-a/index.js` (Plugin.define, logs to JSONL). Scripts: `harness.ts`, `mock.ts`, `s0..s4.ts`, `plugin-a|b|c/`. Outputs: `out1.txt`, `out2.txt`, `out1-gpt.txt`.
All runs in `/private/var/folders/.../T/spike-v2-*` (profile, requests.json, plugin-log.jsonl, server.log). Nothing touched in the repo or the real profile.

## Q1. Files touched by a session

Tools the model sees (request body, default non-GPT model id `test`):
`edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute`.
With a model id `gpt-5` the file tools change: `glob, grep, patch, question, read, shell, skill, subagent, webfetch, websearch, execute`
(`edit`/`write` replaced by `patch`; `tool.list()` returns both, the model sees one set depending on model family).
Code Mode `execute` exists (`{code}`) but its catalog (system prompt) lists only `tools.browser.*` and `tools.opencode.*`
(models, session_rename, session_move, list_mcp_resources...). File tools (edit/write/read/shell) are NOT in the catalog:
the model edits files with direct tool calls. Plugin tools (memory_*) are what goes through `execute`.
Renames vs V1 confirmed in the binary: `bash->shell`, `task->subagent`, `apply_patch->patch`, `filePath->path`, `todowrite` removed.

`session.context()` part (assistant message `content[]`), edit:
```json
{"type":"tool","id":"call_spike","name":"edit","executed":false,
 "state":{"status":"completed",
  "input":{"path":"/abs/project/a.txt","oldString":"hello","newString":"hello edited"},
  "content":[{"type":"text","text":"Edited a.txt (1 replacement)"}],
  "metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt...","status":"modified","additions":1,"deletions":1}],"truncated":false}},
 "time":{"created":..,"ran":..,"completed":..}}
```
- `write`: `input:{"path":"c.txt","content":"..."}` (path may be RELATIVE, as the model sent it); metadata has no `files`.
- `patch` (GPT models): `input:{"patchText":"*** Begin Patch\n*** Add File: d.txt..."}`; `metadata.files[].file` = "d.txt", `.patch` has ABSOLUTE paths.
- `shell`: `input:{"command":"echo more >> b.txt"}`, nothing about files.
- Key is `path`, NOT `filePath`. Part `type:"tool"`, `name` = tool name, `state.status` completed|error (errors keep `input`, maybe `{}`).

**Best source found (not in the plan):** each assistant message carries a git-snapshot diff of the files it changed,
regardless of which tool (edit, write, patch, shell, execute):
```json
"snapshot":{"start":"417d1b9f...","end":"9a591fc3...","files":["a.txt"]}   // edit
"snapshot":{...,"files":["c.txt"]}   // write       "files":["b.txt"] // shell echo >>      "files":["d.txt"] // patch
```
Paths are relative to the worktree. Messages with no changes have `files: []`. Caveats: in a NON-git project `snapshot` is `undefined`
(verified: `[null,null]`), so fall back to tool inputs there. A failed tool call gives `files: []`.
`GET /api/session/{id}/diff` returned `[]` in my run (not investigated further; also not exposed on `ctx.session`).

Hooks, same call:
```json
tool.before {"tool":"edit","sessionID":"ses_..","agent":"build","messageID":"msg_..","id":"call_spike",
             "input":{"path":"/abs/project/a.txt","oldString":"hello","newString":"hello edited"}}
tool.after  {... same ids ..., "input":{...}, "status":"completed",
             "result":{"output":{"files":[{"file":"a.txt","patch":"..","additions":1,"deletions":1,"status":"modified"}],"replacements":1},
                       "content":[{"type":"text","text":"Edited a.txt (1 replacement)"}],"metadata":{...}}}
tool.after (write) result.output = {"operation":"write","target":"/abs/project/c.txt","resource":"c.txt","existed":false}
tool.after (patch) result.output = {"applied":[{"type":"add","resource":"d.txt","target":"/abs/.../d.txt"}],"files":[...]}
tool.after on error: {"status":"error","error":{"_tag":"Tool.Error","message":"..."}}
```
Nested calls inside `execute` fire hooks too with the underlying name: `execute` before, then `opencode_models` before/after, then `execute` after
(tool ids in hooks use underscores `opencode_models`, catalog uses `tools.opencode.models`).
`tool.after` for `write` gives the absolute path in `result.output.target` (more reliable than `input.path`).

Implication PR3 (anchors): primary source = `snapshot.files` of the assistant messages from `ctx.session.context()`
(works with edit/write/patch/shell, git projects); fallback (non-git) = parts with `type:"tool"`, `state.status==="completed"`,
name in {edit, write -> `input.path`; patch -> parse `patchText` or `state.metadata.files[].file`}; resolve relative paths against the
session directory. Do not rely on `filePath` and do not look for `apply_patch`/`bash`/`todowrite` names.

## Q2. ctx.vcs

Input: `ctx.vcs.get(input?)`, `status(input?)`, `diff({mode:"working"|"branch"|"committed", base?, context?})`; the argument is optional.
IMPORTANT: `input.location.directory` is accepted by the types but IGNORED in plugin context: calls with `{location:{directory: <other dir>}}`
returned `location.directory` = the plugin's own location (the server cwd). ctx.vcs is always scoped to `ctx.location.directory`.
Also: the plugin was set up once, for the first location (server cwd); a session created via API for a different `directory` did not
get the plugin's command registered (`GET /api/command` for that directory -> `data: []`). I did not test whether hooks fire for sessions of
other directories (not determined).

Git project (clean, then with modified a.txt / new c.txt / modified b.txt):
```json
vcs.get    -> {"location":{"directory":"..."},"data":{"provider":"git","branch":{"current":"main","default":"main"}}}   ~0.1-0.4 ms
vcs.status -> data: [] (clean) ; after edits: [{"file":"a.txt","additions":1,"deletions":1,"status":"modified"},{"file":"c.txt","additions":1,"deletions":0,"status":"added"}]   15-48 ms
vcs.diff({mode:"working"}) -> data: [{"file":"a.txt","patch":"diff --git a/a.txt b/a.txt\nindex ..","additions":1,"deletions":1,"status":"modified"}, ...]   17-43 ms
```
Untracked files appear as `status:"added"`. status/diff lines carry paths relative to the repo.
Non-git dir (server started with cwd outside git):
```json
vcs.get    -> {"data":{"branch":{}}}   (no `provider`)    ~0.1 ms
vcs.status -> data: []    ~0.1 ms          vcs.diff -> data: []    no errors thrown
```
So "not a git repo" is detected by `get().data.provider === undefined`; nothing throws. Note: `status` in a non-git dir returns [] even with
modified files (cannot see changes there).
Implication: for PR3, `vcs.status()` is a cheap (~20-50 ms) cross-check of "dirty files in project", but it is project-wide, not session-scoped.

## Q3. Todo

No. The model's tool list has no todo tool, `tool.list()` (60 ids) has none, and the binary contains an explicit migration note:
"The `todowrite` tool is no longer available and must not be called". So there is no `execute.after` / part to read todos from.
Implication PR4: drop "todos" from the handoff (or derive "open work" some other way, e.g. from the last assistant text / compaction summary).

## Q4. First request detection

Yes. `session.hook("context")` event fields: `["sessionID","model","system","messages","options","agent","tools"]`
(`model:{id,providerID,variant}`, `agent:"build"`, `system` 4 parts, `options` = {}, `tools` = map name -> {description,input}).
User message counts:
```
prompt 1: event.messages roles ["user"]                        ctx.session.context types ["user"]                       -> 1 user
prompt 2: event.messages roles ["user","assistant","user"]      ctx.session.context types ["user","assistant","idle","user"] -> 2 users
```
`event.messages` alone is enough (count `role==="user"` === 1) and needs no extra call; in `session.context()` the type is `"user"`.
Caveat: after a compaction the model-facing `messages` changes (not tested), so "first request" should use `session.context()` user count
(or a per-session in-memory flag) rather than event.messages. `session.hook("prompt")` also exists: `{sessionID,messageID,prompt:{text},metadata,delivery:"steer"}`.
Subagent/child sessions each have their own sessionID, so they are a "first request" too.

## Q5. command.transform

Yes, works. `ctx.command.transform(editor => editor.add({name:"memory-spike", description, execute}))`.
- Appears in `ctx.command.list()` and `GET /api/command`: `{"name":"init",...},{"name":"review",...},{"name":"memory-spike","description":"spike command"}`
  (entries only have name + description).
- Invoke: `POST /api/session/{id}/command {"name":"memory-spike","text":"some args"}` -> 204; this runs `execute` and
  NO model request is made by itself:
```json
command.execute {"sessionID":"ses_..","prompt":{"text":"some args"},"delivery":"steer"}   // CommandInvocation
```
`execute` returns `Promise<void>`: to emulate the old `commands/memory.md` prompt the plugin must itself call
`ctx.session.prompt({sessionID, text: <template + args>})` (or `ctx.session.synthetic`); I did NOT test that call from inside execute, nor
the TUI slash-menu / `opencode run --command` path (could not drive the TUI here).
Implication PR5: native `/memory` is feasible; the template of `commands/memory.md` moves into the plugin and `execute` forwards it with
`session.prompt`. Names with a hyphen worked; a bare `memory` name was not tried but there is no reason it would not.

## Q6. session.hook("compaction")

Triggered for real: `POST /api/session/{id}/compact {}` -> `{"data":{"id":"msg_..","type":"compaction","payload":{},"delivery":"steer"}}`.
Hook payload:
```json
hook.compaction {"keys":["sessionID","model","system","messages","options","agent","tools"],"sessionID":"ses_..","messagesCount":2,"hasResult":false}
```
= `SessionCompaction extends SessionContext` (+ optional mutable `result?: {summary, providerState?, metadata?, tokens?}`;
setting `result` skips the model request). Fires BEFORE the compaction request, with the messages to be summarized, so a plugin could update the
handoff there. The mock returned a non-template reply so the compaction ended `{"type":"compaction","status":"failed","reason":"manual",
"error":{"type":"compaction.failed","message":"Compaction summary did not match the required template"}}` (retried once); irrelevant to the hook.
Compaction request template includes a "Relevant Files" section produced by the model itself.

## Q7. "./server" export

Not needed. Loading by directory path in `plugins: [dir]` (same as verify-runtime with `packageDir`), `GET /api/plugin` shows
`{"id":"spike.v2","source":{"type":"local","path":".../index.js"},"features":{"server":true},"state":{"status":"active"}}` for three layouts:
1. `exports: { ".": "./index.js" }` (plugin-a, no ./server) -> active
2. only `"main": "./index.js"` (plugin-b) -> active
3. only `exports: { "./server": "./index.js" }` (plugin-c) -> active
So the package root entry (`exports["."]` or `main`) is enough; `./server` is also still honored but optional. Default export must be the
`Plugin.define({id,setup})` object. Not tested: loading by npm package NAME from a registry install (no network); verify-package does the name import.
Implication PR1: `server.js` and `exports["./server"]` can be removed once `src/index.ts` default-exports the V2 plugin; keep `"."`.
(verify-package line ~75 checks `${PKG_NAME}/server` and `plugin.server` -> must be updated too.)

## Other observations
- `@opencode/plugin` must be resolvable from the plugin dir (I symlinked the repo's node_modules); the runtime does not inject it.
- Setup ctx keys: app, location, options, agent, aisdk, command, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell.
- Plugin cleanup fn was called on server shutdown.


## Correction (2026-10-13, after the spike)

Q7 is wrong as stated. The test plugins all had a root `index.js`, which is what OpenCode 2.0.18 actually resolves. With the entry only in `dist/index.js`, OpenCode does not even attempt to load a local package directory (no "loading plugin" log line), regardless of `main`/`exports`. A root `server.js` or `index.js` re-exporting the build is required, so `server.js` and the `./server` export stay. Confirmed with `verify:runtime` against the real CLI.
