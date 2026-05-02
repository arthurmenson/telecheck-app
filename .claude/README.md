# `.claude/` — Claude Code project configuration

This directory is the project-scoped Claude Code configuration for the Telecheck app code repo, authored per **EHBG §13** (Engineering Handoff & Build Guide v1.3, "Setting up Claude Code for this project").

## Contents

```
.claude/
├── settings.json                        ← project hooks, permissions, env
├── README.md                            ← this file
└── skills/
    ├── tenant-scoped-endpoint/SKILL.md  ← scaffold a tenant-scoped Fastify route
    ├── state-machine-transition/SKILL.md← implement a State Machines v1.1 transition
    ├── migration-with-rls/SKILL.md      ← author a tenant-scoped table migration
    ├── slice-implementation/SKILL.md    ← read a slice PRD and produce code
    ├── audit-emission/SKILL.md          ← emit AUDIT_EVENTS v5.2 envelopes
    └── notification-emission/SKILL.md   ← fire notifications through channel hierarchy
```

## After cloning / first run

Claude Code does not auto-reload hooks from disk on every restart. Run `/hooks` once after cloning (or after any change to `settings.json`) so the watcher registers the hook handlers, then restart the session if hooks still don't fire on tool calls.

## Spec corpus path

Skills reference the spec corpus via the env var:

```
TELECHECK_SPEC_PATH=../telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE
```

Set in `settings.json → env`. Override at the shell level if your workspace layout differs (e.g., `export TELECHECK_SPEC_PATH=/abs/path/to/bundle`).

## Tool dependencies

The hooks shell out to:

- **`jq`** — required. Hooks parse Claude Code's stdin JSON via `jq -r`. Install on Windows via `winget install jqlang.jq`, on macOS via `brew install jq`. **Engineering Lead must confirm `jq` is on every dev workstation; CI image must bundle it.**
- **`grep`** — used by the secret scanner and the RLS migration check. Git Bash on Windows ships with GNU grep; macOS/Linux native.
- **`npm run lint`, `npm run typecheck`, `npm run openapi:validate`, `npm run migrate:diff`** — wired through `package.json`. The latter two are TODO stubs at bootstrap; first slice implementation will make them real (see `package.json`).

## Hook reference

All hooks receive Claude Code's standard JSON event payload on stdin. Per the Claude Code hook contract:

- `PreToolUse` payload: `{hook_event_name, session_id, transcript_path, cwd, permission_mode, tool_name, tool_input: {...}}`
- `PostToolUse` payload: same plus `tool_response: {...}`

A hook responds with either:
- exit code `0` and no stdout (no-op) — silently allow the tool call
- a JSON object on stdout: `{"decision": "block", "reason": "..."}` to prevent the tool call (PreToolUse), or `{"systemMessage": "..."}` to surface a warning to Claude

| Hook | Event | Match | Behavior |
|---|---|---|---|
| pre-commit lint + typecheck | `PreToolUse` | `Bash` where `tool_input.command` starts with `git commit` | runs `npm run lint && npm run typecheck`; **blocks** the commit on failure |
| protected-path warning | `PreToolUse` | `Bash` where command touches `migrations/`, `tests/invariants/`, or `audit_records` | emits a `systemMessage` warning (does not block) |
| secret scanner | `PreToolUse` | `Write` or `Edit` (any path) | scans `tool_input.content` and `tool_input.new_string` for API key / private key / DB-URL-with-creds shapes; **blocks** if any match |
| migration reminder | `PostToolUse` | `Write`/`Edit` on `migrations/*.sql` | emits a `systemMessage` reminding to run `npm run migrate:diff` and verify RLS |
| tenant-scoped table RLS check | `PostToolUse` | `Write`/`Edit` on `migrations/*.sql` | re-reads the file; if `tenant_id` appears but `ENABLE ROW LEVEL SECURITY` does not, emits a warning (does not block — author may still be drafting) |
| OpenAPI validate | `PostToolUse` | `Write`/`Edit` on `**/openapi*.{yaml,yml,json}` | runs `npm run openapi:validate`; emits a warning if it fails |

### Block-vs-warn trade-offs

- **Pre-commit lint/typecheck** **blocks**: an unclean commit will fail CI anyway, so blocking client-side saves a round-trip.
- **Secret scanner** **blocks**: pushing secrets is irreversible and a high-severity event. False positives are rare; if one happens, override by editing the value (e.g., `sk-ant-EXAMPLE...`) so the regex no longer matches, or stage the file directly via `git`.
- **Protected-path warnings** **warn only**: legitimate work in `migrations/` is common, so blocking would be too noisy. The `Edit(migrations/**)` permission rule in `settings.json → permissions.ask` provides the gate.
- **RLS migration check** **warns only**: an in-progress migration may not yet have its RLS policy added; the `migrations/` permission gate plus engineer review is the real guard. The warning is a nudge, not a block.

## Permissions

- **Allow**: read-only ops + npm/git/standard dev tools + free Read/Edit/Write across `src/`, `tests/`, docs.
- **Ask**: any Edit/Write to `migrations/**` (sensitive — Engineering Lead reviews) and any database-migration command.
- **Deny**: writes to `audit_records/`, and bash commands that look like UPDATE/DELETE/TRUNCATE on the audit table. Audit append-only is **I-003** — not negotiable.

## Skills

Each skill is one `SKILL.md` (under 200 lines) with frontmatter, "When to use this skill", "Read first" (canonical spec files), "Workflow" (numbered steps), "Hard rules" (invariants), "Common mistakes", and "Reporting" sections.

Skills are **not** auto-invoked. Claude Code reads the skill registry on session start; the user (or Claude reasoning about a task) decides which skill to apply.

## Editing rules

- Do not edit `settings.json` to relax `audit_records` deny rules. I-003 platform-floor.
- Do not edit hook commands to skip secret scanning. If a hook produces a false positive, fix the regex via PR review.
- Skills are revised whenever the underlying spec ratchets — when a Contracts Pack file bumps version (e.g., AUDIT_EVENTS v5.2 → v5.3), update the skill body and frontmatter pointer.
