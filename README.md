# OrgSpec

Spec-driven development that follows your organisation's own rules. Each change starts as a spec. Claude Code works on it under the organisation's constitution, and CI checks the result before it merges.

OrgSpec is one Node application that runs only on each person's machine. There is no OrgSpec server. It keeps shared state in systems the organisation already has:

- Jira gate fields
- `approvals.yaml` in each repository
- an `orgspec-config` repository
- restricted Confluence pages

- **All AI goes through the Claude CLI.** Interactive work runs in `claude` and jobs run as `claude -p --agent <name>`. OrgSpec holds no API keys and stores no embeddings.
- **Tools only through MCP.** Jira, Confluence, Slack, HR, calendar and the organisation's CI are reached through MCP servers, proxied by OrgSpec's own gateway. GitHub is reached through `gh` and `git`.
- **Writes happen as you, after you click.** Anything a Claude session wants to send waits under Approvals.

---

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Try it without real systems](#try-it-without-real-systems)
- [Concepts](#concepts)
- [The dashboard](#the-dashboard)
- [Command reference](#command-reference)
- [Organisation configuration (`orgspec-config`)](#organisation-configuration-orgspec-config)
- [CI integration](#ci-integration)
- [Security model](#security-model)
- [Where data lives](#where-data-lives)
- [Developing OrgSpec](#developing-orgspec)
- [Releasing](#releasing)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
                 ┌──────────────── your machine ────────────────┐
                 │                                              │
  orgspec-config │  orgspec CLI ── daemon ── dashboard          │
  (git, admins)  │      │            │      (127.0.0.1)         │
       │         │      │            └── sync: Jira, Confluence,│
       ▼         │      ▼                Slack, CI, HR, gh      │
  compiled       │  ticket packet ──► claude (interactive/--bg) │
  constitution ──┼─► agents, rules,       │                     │
  per persona    │   hooks, gateway       ▼                     │
                 │                  orgspec gateway (MCP) ──────┼──► upstream MCP servers
                 │                  Cedar policy, confirmations,│    (Atlassian, Slack, CI, HR…)
                 │                  egress checks, audit        │
                 └──────────────────────────────────────────────┘
                              │ git push / gh pr
                              ▼
                     org CI runs `orgspec check`
```

1. **Admins** keep the organisation's rules in Confluence. They compile them into a versioned, signed-by-hash constitution bundle for each persona, stored in the `orgspec-config` repository.
2. **People** pick a persona, such as engineer, engineering manager or project manager. OrgSpec then shows them the screens and tools for that role.
3. **Work happens in ticket packets.** `orgspec packet PAY-123` creates a folder with a git worktree for each repository involved. The folder also holds the persona's agents and rules, the policy hooks and an MCP config that points only at the OrgSpec gateway. Claude Code runs there.
4. **The gateway** is the only MCP server Claude Code loads. It allows only the tools the persona grants, asks for confirmation on writes and wraps upstream content as untrusted. It also blocks unknown destinations and audits every call.
5. **CI** runs `orgspec check` on each pull request. It checks strict spec validation, test traceability, the tier floor, approvals and the compiled CI rules.

---

## Install

The package is public on npm:

```bash
npm install -g @shawmanmohan/orgspec
```

```bash
orgspec --version
```

**Requirements**

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 22.13 or newer | Runtime; uses the built-in `node:sqlite` |
| Claude Code (`claude`) | 2.1.282 or newer | Every AI call, interactive and background sessions |
| GitHub CLI (`gh`) | recent | Pull requests, account switching, approvals |
| git | 2.40 or newer | Worktrees for ticket packets |
| macOS or Linux | — | The OS keychain holds the local data key (macOS Keychain or libsecret) |

A single-file executable is also available. It bundles Node, so it needs nothing else installed. Build it with `pnpm package` (see [Developing OrgSpec](#developing-orgspec)).

---

## Quick start

1. **Point OrgSpec at your organisation's config and say who you are**:

   ```bash
   orgspec setup --config acme/orgspec-config --email you@acme.io
   ```

2. **Connect the MCP servers** your organisation uses. This runs each server's OAuth sign-in, then checks OrgSpec's tool mappings against the server's live tool list. For Atlassian it also prints the `cloudId` that `integrations.yaml` needs:

   ```bash
   orgspec connect atlassian
   ```

3. **Tell OrgSpec where your repositories are checked out**:

   ```bash
   orgspec settings repo add acme/payments --path ~/src/payments
   ```

4. **Map GitHub organisations to `gh` accounts**, if you use more than one:

   ```bash
   orgspec github map acme you-work
   ```

5. **Check everything**:

   ```bash
   orgspec doctor
   ```

6. **Start the local service and open the dashboard**:

   ```bash
   orgspec service install
   ```

   ```bash
   orgspec dashboard
   ```

7. **Pick up a ticket**:

   ```bash
   orgspec packet PAY-123
   ```

   This creates `~/orgspec-tickets/PAY-123/` with a worktree for each repository, the session files, the agents and rules, and the gateway config. It then opens Claude Code there. Use `--launch background` to start a background session that you follow from **My agents**.

   The first time, trust the ticket root once by running `claude` in `~/orgspec-tickets`. Background sessions in every ticket folder under it can then start.

---

## Try it without real systems

`orgspec-demo-workplace` is a made-up workplace behind MCP: HR, calendar, Jira, Confluence, Slack and CI, with people, tickets, PRDs and messages that are all fictional. It lets you use every screen before you connect anything real.

Point `integrations.yaml` in a scratch copy of the example config at it, one server per kind:

```yaml
servers:
  atlassian: { transport: stdio, command: orgspec-demo-workplace, args: [atlassian, /tmp/demo-state.json] }
  hr:        { transport: stdio, command: orgspec-demo-workplace, args: [hr,        /tmp/demo-state.json] }
  calendar:  { transport: stdio, command: orgspec-demo-workplace, args: [calendar,  /tmp/demo-state.json] }
  slack:     { transport: stdio, command: orgspec-demo-workplace, args: [slack,     /tmp/demo-state.json] }
  ci:        { transport: stdio, command: orgspec-demo-workplace, args: [ci,        /tmp/demo-state.json] }
constants: { cloudId: demo-cloud }
```

The example config is in the installed package under `examples/orgspec-config`. You can find the package folder with `npm root -g`.

Set your identity to `you@acme.io` with Slack ID `U00YOU`, then sync each source:

```bash
orgspec settings identity --email you@acme.io --slack U00YOU
```

```bash
orgspec sync jira.active
```

To keep your real setup untouched, run the demo with a separate home folder, for example `ORGSPEC_HOME=/tmp/orgspec-demo ORGSPEC_KEYSTORE=file`. Reviews, briefs, summaries and compiles still run through your own `claude` CLI.

---

## Concepts

### Specs and changes

A repository opts in with an `orgspec/` folder:

```
orgspec/
  repo.yaml                 # repository settings, capabilities → code paths
  specs/<capability>/spec.md
  changes/<change-id>/
    proposal.md  design.md  tasks.md  meta.yaml
    specs/<capability>/spec.md   # delta spec
  decisions/ADR-0001-*.md
  archive/
```

Requirements and scenarios have stable IDs:

```markdown
### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 3 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried at most 3 times
```

Delta specs use `## ADDED`, `## MODIFIED`, `## REMOVED` and `## RENAMED Requirements` (`- {#id} → New name`), all matched by ID.

- **`orgspec rebase`** refreshes the base hashes when the main spec changes underneath a change.
- **`orgspec archive`** merges a change into the main specs deterministically, by ID.
- **`orgspec trace`** finds `@scenario <id>` citations in tests, so CI can require every scenario to be tested.

### Tiers

Every change has a tier, such as a small fix or a feature. The tier decides which artifacts it needs and who must approve them. The constitution sets a floor: a change that touches certain paths or capabilities can't claim a lower tier than that floor.

### Personas and the constitution

- **Persona:** a role (engineer, engineering manager, project manager, and so on). It decides:
  - which compiled constitution bundle applies
  - which agents and models are used
  - which MCP tools are granted and which need confirmation
  - which `gh` commands are allowed
  - which dashboard screens appear
- **Constitution:** rules extracted from the organisation's Confluence pages by a grounded compile.
  - Each rule cites the page it came from.
  - Each rule has a severity and a check, which can be a hook rule, a CI rule or an agent instruction.
  - Rules carry stable IDs.
  - Overlays can only tighten rules, never loosen them.
- **Waivers:** time-limited exceptions for a repository or path. They live in the config repository with an owner and an expiry date.

### Approvals

Approvals are commits to `approvals.yaml` in the repository. Each approval records the approver, the artifact and its content hash. CI checks that:

- the approver is allowed to approve that artifact
- the approver is not the pull request's author
- the artifact has not changed since it was approved

### Ticket packets and sessions

A packet is the working folder for a ticket. It contains:

| File | Purpose |
| --- | --- |
| `session.json` | Ticket, persona, repositories and branches, and the session ID |
| `hook-rules.json` | The compiled hook rules the `PreToolUse` hook enforces, such as no force-push and no edits outside the worktrees |
| `.claude/agents/*`, `.claude/rules/*` | The persona's agents and its constitution as Claude Code rules |
| `.claude/settings.json` | OrgSpec's hooks (`pre-tool-use`, `checkpoint`, `restore`, `session-end`) |
| `.orgspec/mcp.json` | Loads only the OrgSpec gateway (`--mcp-config … --strict-mcp-config`) |

The checkpoint and restore hooks save the session's progress to the ticket, so another person or another machine can pick it up with `orgspec resume`.

---

## The dashboard

`orgspec daemon` serves the dashboard on http://127.0.0.1:47320, or on any free port when that one is taken. `orgspec dashboard` opens it with a one-time login token. Each persona's `views` decide which screens appear.

| Area | Screens |
| --- | --- |
| Everyone | Choose your workspace · Settings and privacy · Approvals · Reminders · Task inbox (send to Jira) · Slack summarizer · Decisions (browse and record) · My agents · Zen (start and session) |
| Engineer | My work · Ticket (send to agent, check against the spec) · My 1:1 evidence |
| Engineering manager | Review queue · PRD review · Task breakdown to Jira · Team & 1:1s · 1:1 prep |
| Project manager | Programs · Program detail with nudges · Share status update |
| Admin mode | Sources & compile · Bundle review · Waivers · Personas · Sync |

What each screen does:

- **Task inbox:** pulls requests, commitments and questions out of your Slack DMs and saved items. It merges duplicates, explains why each item is there, and lets you send it to Jira as yourself.
- **Slack summarizer:** summarises channels or links over a time window. It matches the results to existing Jira issues and flags conflicts with recorded decisions.
- **PRD review:**
  - Scores PRDs for completeness, risk, dependencies and feasibility against the persona's rubric.
  - Checks them against past decisions.
  - Posts the findings as Confluence comments.
  - Sets the Jira review field once every blocker is resolved.
- **Task breakdown:** drafts epics and stories from an approved PRD. Each item goes to the right team's Jira project, duplicates are detected, and the items are created with blocked-by links.
- **Team & 1:1s, 1:1 prep and My 1:1 evidence:**
  - Briefs come from Jira, pull requests, allowlisted work channels and the career framework.
  - Notes are stored encrypted on your machine.
  - When a report moves teams, the manager's access ends on the move date, and the former manager's briefs, notes and agreed actions about that person are deleted from their machine.
- **Check against the spec (ticket page, `orgspec verify`):** before you open or update a PR, a `claude -p` verifier judges the branch diff against each scenario the change adds or modifies, and gives you a Markdown section for the PR description. It is advisory; only the deterministic trace in `orgspec check` can block a merge.
- **Zen mode:**
  - A private focus session of up to three items, suggested from incidents, security work, people blocked on you, things due today and your current tickets, in the org's order from `zen.yaml`.
  - Reminders wait for one end-of-session digest, except incidents and on-call pages.
  - It sets your Slack status and Do Not Disturb and restores them afterwards. It can also auto-reply to DMs once per conversation and freeze your other agents until the end.
  - Sessions stay on your machine and are never a metric.
- **Programs:**
  - Risk scores are deterministic: dependencies, a resampled-throughput forecast, activity, review wait and scope.
  - Scores never judge people.
  - Nudges respect the recipient's time zone and are sent only by you.
- **Reminders:** PRD review deadlines, decisions due for review, stale approvals, spec drift, unanswered findings and expiring waivers. They arrive as a Slack DM to yourself, or as a desktop notification when Slack isn't connected, and link back to the dashboard.

---

## Command reference

Every command accepts `--json`, which prints exactly one JSON document on stdout. Commands exit with code 1 when there are errors.

| Area | Commands |
| --- | --- |
| Specs | `init`, `new <JIRA>`, `status`, `show`, `list`, `validate [--strict]`, `rebase`, `archive [--ci]`, `trace` |
| Setup | `setup`, `doctor`, `managed-settings`, `connect <mcp-server>`, `integrations check [server…]`, `service install` |
| Work | `packet <JIRA>`, `packets`, `resume`, `cleanup`, `session list\|logs\|attach\|stop\|respawn\|rm` |
| Review | `review prd <pageId>`, `review design <change>`, `plan <change>`, `verify <change>`, `findings`, `approve <change> <artifact>` |
| Focus | `zen [status]`, `zen suggest`, `zen start [--minutes] [--item] [--freeze] [--auto-reply]`, `zen done <id>`, `zen extend`, `zen end` |
| CI | `check --base origin/main --config <orgspec-config> --persona engineer` |
| Knowledge | `decision new\|index\|search` |
| People | `inbox [sync\|done\|dismiss]`, `summarize <channel>`, `risk`, `1on1 roster\|brief\|agenda\|note\|notes` |
| Local service | `daemon`, `dashboard`, `sync [source]`, `actions list\|approve\|reject`, `reminders` |
| Settings | `settings show\|persona\|identity\|repo\|interval\|quiet-hours\|terminal\|send-mode\|dm-inbox\|reminders\|jira` |
| GitHub (`gh`) | `github status\|switch\|login\|logout\|setup-git\|map\|unmap\|auto-switch` |
| Admin | `admin check\|compile\|eval\|diff\|publish\|rollback\|waiver\|personas\|people` |

Claude Code itself calls two more commands:

- `orgspec hook pre-tool-use|checkpoint|restore|session-end`
- `orgspec gateway --stdio --session <id>`

Run `orgspec <command> --help` for each command's options.

---

## Organisation configuration (`orgspec-config`)

The organisation's admins keep one git repository. [`examples/orgspec-config`](examples/orgspec-config) is a complete example, and a test keeps it valid.

| Path | What it holds |
| --- | --- |
| `personas/*.yaml` | A persona's bundle and its hash, agents, MCP grants (`tools`, `confirm`), `gh` commands, eligibility and dashboard `views` |
| `constitution/base.yaml`, `constitution/overlays/*.yaml` | The Confluence source pages to compile, plus tighten-only overlays for each team or persona |
| `compiled/<persona>/<version>/` | Published bundles: `rules.json`, `checks.json`, `constitution.md`, rubrics and a `manifest.json` with hashes |
| `integrations.yaml` | MCP servers (stdio or http, OAuth), constants, overrides of the logical operations each tool maps to, and the egress allowlist |
| `sync.yaml` | Polling intervals for each source |
| `zen.yaml` | Zen mode limits: maximum length, focus priority order, the "waiting on you" threshold and extra break-through reminder kinds |
| `jira.yaml` | Gate field IDs, the PRD label and the mapping from teams to projects |
| `roles.yaml` | Who may approve which artifacts, by tier |
| `people.yaml` | Team leads, allowlisted evidence channels and HR as the source of reporting lines |
| `waivers/*.yaml` | Time-limited exceptions |
| `policies/*.cedar` | Extra Cedar policies the gateway enforces |
| `evals/*.yaml` | Golden evals. A compile that makes them worse can't be published |

**Tool names differ between MCP servers.** OrgSpec talks to logical operations, such as `jira.search` or `ci.listRuns`, and maps each one to a tool. When your server names its tools differently, override the mapping in `integrations.yaml`:

```yaml
operations:
  ci.listRuns: { tool: ci__builds_search, args: { project: $repo, branch: $branch } }
```

`orgspec integrations check` finds the mappings to fix. For each server it reports:
- tools the server doesn't offer, with the closest name it does offer
- arguments that aren't in a tool's input schema
- required arguments that aren't mapped
- for Atlassian, whether `constants.cloudId` is one of your sites

`orgspec connect` and `orgspec doctor` run the same check. The defaults follow the Atlassian Rovo MCP server's v2 tool names. Use `https://mcp.atlassian.com/v2/mcp?tools=all`, the flat tool list that Atlassian recommends for gateways. Atlassian publishes tool names but not argument schemas, so run the check once with a real sign-in.

**Compiling the constitution** is done in Admin mode, or from the CLI:

```bash
orgspec admin compile
```

```bash
orgspec admin eval
```

```bash
orgspec admin publish
```

The extractor sees the rules already compiled from each page, so rule IDs and checks stay stable between compiles. Publishing is blocked when the golden evals get worse or when a persona would lose all of its rules.

---

## CI integration

Your organisation's CI runs OrgSpec on each pull request and after each merge. [`examples/ci`](examples/ci) has both steps:

- `orgspec-check.sh`: the pull-request gate.

  ```bash
  orgspec check --base origin/main --config ./orgspec-config --persona engineer --repo acme/payments --author "$PR_AUTHOR"
  ```

- `orgspec-archive.sh`: after a merge, archives completed changes into the main specs.

OrgSpec reads CI results back through the CI system's MCP server. Those results feed the ticket page, the gate fields and the reminders.

---

## Security model

- **One MCP server.** Claude Code is started with `--strict-mcp-config` and loads only the OrgSpec gateway.
  - The gateway exposes tools as `server__tool` and checks each call against Cedar policies built from the persona's grants, plus any `policies/*.cedar`.
  - Writes listed under `confirm` wait for your approval.
- **Untrusted content.** Everything returned by upstream tools is wrapped as untrusted data before Claude sees it.
- **Egress.** Calls whose destination is outside `egressAllow` are blocked.
- **Hooks.** The `PreToolUse` hook enforces the compiled hook rules, such as blocking `git push --force`, including through `git -C`, `sh -c`, `eval` and subshells. It runs in about 20 ms.
- **Managed settings.** IT installs the Claude Code managed settings that `orgspec managed-settings` prints. They allow only OrgSpec's hooks and gateway, pin plugin marketplaces and deny dangerous commands. Until IT installs them, ticket folders carry their own hook settings.
- **Audit.** Every gateway call and every write is recorded in a hash-chained audit log.
- **Private data.** 1:1 notes, the inbox and cached messages are encrypted with AES-256-GCM. The data key lives in the OS keychain. You can export or delete your data from Settings.

---

## Where data lives

| What | Where |
| --- | --- |
| Settings, caches, audit, private database | `~/Library/Application Support/OrgSpec` on macOS, `$XDG_DATA_HOME/orgspec` (default `~/.local/share/orgspec`) on Linux, or `$ORGSPEC_HOME` if set |
| Data key | OS keychain. `ORGSPEC_KEYSTORE=file` keeps it in a file instead, for tests and demos only |
| Ticket packets | `~/orgspec-tickets/<KEY>/` |
| Organisation config | Your clone of `orgspec-config` |
| Gate status | Jira fields |
| Approvals | `approvals.yaml` in each repository |

| Environment variable | Effect |
| --- | --- |
| `ORGSPEC_HOME` | Use a different home folder |
| `ORGSPEC_KEYSTORE=file` | Store the data key in a file rather than the keychain |
| `ORGSPEC_SELF` | The command hooks and the gateway use to call OrgSpec. Defaults to `orgspec` on your `PATH` |
| `ORGSPEC_HOOK_MODE=socket` | Hooks forward to the daemon's Unix socket instead of starting a process |

---

## Developing OrgSpec

The repository is a pnpm workspace of TypeScript packages:

| Package | What it is |
| --- | --- |
| `packages/spec-engine` | Spec format: parsing specs and deltas, requirement and scenario IDs, tier schemas, validation, rebase, deterministic archive, trace |
| `packages/core` | Paths, command runner, SQLite stores (`node:sqlite`), keychain-held data key with AES-256-GCM, hash-chained audit, schemas for org config and user settings |
| `packages/constitution` | Rule schema and check DSL, tighten-only layering, waivers, the grounded compile pipeline, verified bundles, CI and hook evaluation |
| `packages/claude` | The `claude -p` job runner (validated JSON, one retry), generators for agents, rules and managed settings, control of background sessions |
| `packages/integrations` | Configurable adapters for Jira, Confluence, Slack, CI, HR and calendar over MCP; `gh` and `git` wrappers with account switching |
| `packages/gateway` | The MCP gateway: namespaced upstream tools, Cedar policy, confirmations, untrusted wrapping, egress checks, audit |
| `packages/app` | Policy hook, `orgspec check`, approvals, packets, checkpoints, gate sync, reviewers, inbox, risk, 1:1s, scheduler, reminders, the local service and dashboard, admin |
| `packages/cli` | The `orgspec` command |

```bash
corepack enable
```

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm test
```

```bash
pnpm lint
```

Run the CLI from source with `pnpm orgspec <command>`.

**Build outputs**

| Command | Output |
| --- | --- |
| `pnpm bundle` | `dist/orgspec.cjs`: one esbuild bundle, plus the Cedar wasm |
| `pnpm package` | `dist/orgspec`: a Node single executable application (signed ad hoc on macOS) |
| `node scripts/npm-package.mjs [--version x.y.z]` | `dist/npm/`: the npm package (`bin/orgspec.cjs`, `demo/demo-workplace.mjs`, `examples/`) |

`scripts/demo-workplace.mjs` is the source of the demo workplace. `scripts/example-bundles.mjs` regenerates the example compiled bundles.

**Implementation notes**

- **Dashboard:** server-rendered HTML from a Fastify service bound to 127.0.0.1, with a token for each start.
- **Private database:** `node:sqlite`, with AES-256-GCM encryption done in the application.
- **Hooks:** they load a lightweight module. With the daemon running, `ORGSPEC_HOOK_MODE=socket` avoids starting a process for each hook.
- **Workspace discovery:** a workspace is a folder that contains `orgspec/repo.yaml`. The search stops at the git root.
- **Claude Code CLI:** background sessions use `claude --bg`, then `claude agents --json`, `attach`, `logs`, `stop`, `respawn` and `rm`.

---

## Releasing

GitHub Actions publishes `@shawmanmohan/orgspec` to npm as a public package.

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request, on Ubuntu and macOS. It lints, builds and tests, then assembles the npm package and smoke-tests installing it.
- **Release** (`.github/workflows/release.yml`) runs when a `v*.*.*` tag is pushed. It runs the same checks, builds the package at the tag's version and publishes it to npm. It then attaches the tarball to a GitHub release.
  - Versions with a pre-release suffix, such as `v0.3.0-rc.1`, are published under the `next` dist-tag.
  - You can also run it by hand from the Actions tab and give it a version.

**One-time setup**

1. Create an npm **granular access token** with read and write access to `@shawmanmohan/orgspec`, or an automation token.
2. Add it to the repository as the secret `NPM_TOKEN`:

   ```bash
   gh secret set NPM_TOKEN --repo shawmanmohan/orgspec
   ```

**Cutting a release**

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `orgspec doctor` reports Claude Code is too old | Update Claude Code to 2.1.282 or newer |
| A background session never starts | Trust the ticket root once: run `claude` in `~/orgspec-tickets` and accept |
| Gateway tools are missing in a session | Check that the persona grants them. Run `orgspec doctor` and `orgspec connect <server>` |
| "OrgSpec policy does not allow …" | The persona doesn't grant that tool. Ask an admin to change the persona, or use a waiver |
| Sync shows a source as failing | Open **Sync** in Admin mode, or run `orgspec sync <source> --json` to see the error. Tool names may need an `operations:` override |
| No spec drift reminders | Add a `capabilities:` map to each repository's `orgspec/repo.yaml` |
| The keychain prompts every time | Choose **Always Allow** for OrgSpec's keychain item, or use `secret-tool` (libsecret) on Linux |

---

## License

[MIT](LICENSE)
