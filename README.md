# OrgSpec

Spec-driven development that follows the organisation's constitution: specs, changes and archives in plain Markdown, plus the organisation's own rules, approvals and tools. OrgSpec is one Node application that runs only on each person's machine. There is no OrgSpec server.

- Every AI call goes through the Claude CLI: `claude` for interactive work and `claude -p --agent <name>` for jobs.
- Jira, Confluence, Slack, HR, calendar and the org's CI are reached only through MCP servers. GitHub is reached only through `gh` and `git`.
- Shared state lives where it already belongs: Jira gate fields, `approvals.yaml` in the repo, the `orgspec-config` repo and restricted Confluence pages.

See the [technical design](https://claude.ai/code/artifact/a0184ae0-aa75-4fc2-bc98-08bcf885c18f) and the [technology stack](https://claude.ai/code/artifact/f83e5219-0a48-482b-b142-651f39fbce21).

## Packages

| Package | What it is |
| --- | --- |
| `packages/spec-engine` | The spec format: spec and delta parsing, requirement and scenario IDs, tiered workflow schemas, validation, rebase, deterministic archive, trace |
| `packages/core` | Local paths, command runner, SQLite stores (`node:sqlite`), keychain-held data key with AES-256-GCM, hash-chained audit, org config and user settings schemas |
| `packages/constitution` | Rule schema and check DSL, tighten-only layering, waivers, the grounded compile pipeline, verified bundles, CI and hook evaluation |
| `packages/claude` | `claude -p` job runner (validated JSON, one retry), agent, rules and managed-settings generators, background session control |
| `packages/integrations` | Configurable Jira, Confluence, Slack, CI, HR and calendar adapters over MCP tools; `gh` and `git` wrappers with account switching |
| `packages/gateway` | The only MCP server Claude Code loads: namespaced upstream tools, Cedar policy from persona grants, confirmations, untrusted wrapping, egress checks, audit |
| `packages/app` | Policy hook, `orgspec check`, approvals, ticket packets, checkpoints, gate sync, reviewers, inbox, risk, 1:1s, scheduler, reminders, the local service and dashboard, admin |
| `packages/cli` | The `orgspec` command and the single-executable entry |

## Develop

```bash
corepack pnpm install
```

```bash
corepack pnpm test
```

```bash
corepack pnpm build
```

```bash
corepack pnpm package
```

`pnpm package` writes `dist/orgspec`: an esbuild bundle injected into a copy of `node` (Node single executable application, signed ad hoc on macOS). It needs Node 22.13 or newer and Claude Code 2.1.282 or newer.

## Getting started

```bash
orgspec setup --config acme/orgspec-config --email you@acme.io
```

```bash
orgspec settings repo add acme/payments --path ~/src/payments
```

```bash
orgspec github map acme you-work
```

```bash
orgspec doctor
```

```bash
orgspec packet PAY-123
```

`orgspec packet` creates `~/orgspec-tickets/PAY-123/` containing:

- a worktree per repository
- `session.json` and `hook-rules.json`
- the agents and `.claude/rules` from the persona's constitution
- a `.mcp.json` that points at the gateway

It then opens Claude Code there, or starts it in the background with `--launch background`.

IT installs the Claude Code managed settings that `orgspec managed-settings` prints. They allow only OrgSpec's hooks and its gateway, pin marketplaces and deny dangerous commands.

## Commands

Every command accepts `--json` (exactly one JSON document on stdout) and exits 1 when there are errors.

| Area | Commands |
| --- | --- |
| Specs | `init`, `new <JIRA>`, `status`, `show`, `list`, `validate [--strict]`, `rebase`, `archive [--ci]`, `trace` |
| Setup | `setup`, `doctor`, `managed-settings`, `connect <mcp-server>`, `service install` |
| Work | `packet <JIRA>`, `packets`, `resume`, `cleanup`, `session list\|logs\|attach\|stop\|respawn\|rm` |
| Review | `review prd <pageId>`, `review design <change>`, `plan <change>`, `findings`, `approve <change> <artifact>` |
| CI | `check --base origin/main --config <orgspec-config> --persona engineer` |
| Knowledge | `decision new\|index\|search` |
| People | `inbox [sync\|done\|dismiss]`, `summarize <channel>`, `risk`, `1on1 roster\|brief\|agenda\|note\|notes` |
| Local service | `daemon`, `dashboard`, `sync [source]`, `actions list\|approve\|reject`, `reminders` |
| Settings | `settings show\|persona\|identity\|repo\|interval\|quiet-hours\|terminal\|send-mode\|dm-inbox\|reminders\|jira` |
| GitHub (gh) | `github status\|switch\|login\|logout\|setup-git\|map\|unmap\|auto-switch` |
| Admin | `admin check\|compile\|eval\|diff\|publish\|rollback\|waiver\|personas\|people` |

Claude Code calls `orgspec hook pre-tool-use|checkpoint|restore|session-end` and `orgspec gateway --stdio --session <id>`.

## Dashboard

`orgspec daemon` serves the dashboard on http://127.0.0.1:47320 (any free port when that is taken); `orgspec dashboard` opens it with a one-time login. Each persona's `views` decide its navigation. Every screen in the design canvas is built:

| Area | Screens |
| --- | --- |
| Everyone | Choose your workspace · Settings and privacy · Approvals · Reminders · Task inbox (send to Jira) · Slack summarizer · Decisions (browse and record) · My agents |
| Engineer | My work · Ticket (send to agent) · My 1:1 evidence |
| Engineering manager | Review queue · PRD review · Task breakdown to Jira · Team & 1:1s · 1:1 prep |
| Project manager | Programs · Program detail with nudges · Share status update |
| Admin mode | Sources & compile · Bundle review · Waivers · Personas · Sync |

Anything that writes to Jira, Confluence, Slack or a calendar runs as you, only after a click, and messages a Claude session wants to send wait under Approvals. Reminders arrive as a Slack DM to yourself (or a desktop notification without Slack) and link back to the dashboard.

### Try it without real systems

`scripts/demo-workplace.mjs` is a fictional workplace behind MCP (HR, calendar, Jira, Confluence, Slack and CI). Point `integrations.yaml` at it, one server per kind:

```yaml
servers:
  atlassian: { transport: stdio, command: node, args: [scripts/demo-workplace.mjs, atlassian, /tmp/demo-state.json] }
  hr: { transport: stdio, command: node, args: [scripts/demo-workplace.mjs, hr, /tmp/demo-state.json] }
  calendar: { transport: stdio, command: node, args: [scripts/demo-workplace.mjs, calendar, /tmp/demo-state.json] }
  slack: { transport: stdio, command: node, args: [scripts/demo-workplace.mjs, slack, /tmp/demo-state.json] }
  ci: { transport: stdio, command: node, args: [scripts/demo-workplace.mjs, ci, /tmp/demo-state.json] }
```

Set your identity to `you@acme.io` (Slack ID `U00YOU`) and run `orgspec sync <source>` for each source. Reviews, briefs, summaries and compiles still run through your own `claude` CLI.

## Configuration

[`examples/orgspec-config`](examples/orgspec-config) is a complete `orgspec-config` repository that a test keeps valid. It contains:

- personas and constitution overlays
- `integrations.yaml`: MCP servers, tool mappings and egress
- `sync.yaml`: polling intervals
- `jira.yaml`: gate fields
- `roles.yaml`, `people.yaml` and waivers
- Cedar policies
- golden evals
- seed bundles

[`examples/ci`](examples/ci) has the pull-request and post-merge steps for the org's CI system.

## Spec format

```markdown
### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 3 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried at most 3 times
```

Delta specs use `## ADDED`, `## MODIFIED`, `## REMOVED` and `## RENAMED Requirements` (`- {#id} → New name`), all matched by ID.

## Where the implementation differs from the design documents

- **Encryption:** the private database uses `node:sqlite` with AES-256-GCM in the application. The data key lives in the OS keychain. SQLCipher is not used.
- **Dashboard:** server-rendered HTML from the local Fastify service on 127.0.0.1, with a per-start token. It is not a Next.js app.
- **Tool names:** gateway tools are named `server__tool` (for example `atlassian__getJiraIssue`), because MCP tool names cannot contain dots.
- **Hook latency:** the hook loads only a light module and takes about 20 ms. With the daemon running, `ORGSPEC_HOOK_MODE=socket` forwards to its Unix socket.
- **Ticket folders:** the default ticket root is `~/orgspec-tickets`. A workspace is a folder whose `orgspec/repo.yaml` exists, and the search stops at the git root.
- **Claude sessions:** OrgSpec starts every session with `--mcp-config .orgspec/mcp.json --strict-mcp-config`, so the gateway loads without the project MCP approval prompt and no other MCP server can. Ticket folders also get `.claude/settings.json` with the hooks, which apply until IT installs the managed settings (`allowManagedHooksOnly` then takes over). Trust the ticket root once with `claude`; background sessions in every ticket folder under it then start.
- **Programs:** risk scores are deterministic (dependencies, a resampled-throughput forecast, activity, review wait, scope), never about people; Claude only drafts summaries and status updates.
- **Compiles:** the extractor sees the rules currently compiled from each page so IDs and checks stay stable; publishing is blocked when golden evals regress or a persona would lose all its rules.
