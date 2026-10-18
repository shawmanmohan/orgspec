# OrgSpec

Spec-driven development that follows the organisation's constitution. OrgSpec is one Node application that runs only on each person's machine; see the [technical design](https://claude.ai/code/artifact/a0184ae0-aa75-4fc2-bc98-08bcf885c18f) and [technology stack](https://claude.ai/code/artifact/f83e5219-0a48-482b-b142-651f39fbce21).

## Packages

| Package | What it is |
| --- | --- |
| `packages/spec-engine` | The spec format: spec and delta parsing, requirement and scenario IDs, tiered workflow schemas, validation, rebase, deterministic archive, trace |
| `packages/cli` | The `orgspec` command |

## Develop

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm build
node packages/cli/dist/bin.js --help
```

## Commands

Every command accepts `--json` (exactly one JSON document on stdout) and exits 1 when there are errors.

| Command | Does |
| --- | --- |
| `orgspec init [--team <name>]` | Creates `orgspec/` with `specs/`, `changes/`, `decisions/` and `repo.yaml` |
| `orgspec new <JIRA-KEY> [--slug] [--schema] [--tier low\|medium\|high]` | Starts a change folder with `change.yaml` and a proposal template |
| `orgspec status <change>` | Which artifacts the change's schema and tier still need |
| `orgspec validate [target] [--strict]` | Validates one change or spec, or everything |
| `orgspec rebase <change>` | Pins the main-spec hash of every requirement the change modifies, removes or renames |
| `orgspec archive <change> [--date] [--ci]` | Merges deltas into the main specs by ID and moves the change to `archive/` |
| `orgspec trace <change>` | Checks every new or changed scenario is cited by a test (`// @scenario <id>`) |
| `orgspec list [--specs]`, `orgspec show <id>` | Lists and shows changes and capabilities |

## Spec format

```markdown
### Requirement: Retry failed captures {#payments.retries.capture}
The system SHALL retry a failed card capture up to 3 times.

#### Scenario: Transient gateway error {#payments.retries.capture/transient}
- **WHEN** the gateway returns a 503 on capture
- **THEN** the capture is retried at most 3 times
```

Delta specs use `## ADDED`, `## MODIFIED`, `## REMOVED` and `## RENAMED Requirements` (`- {#id} → New name`), matched by ID.

## Status

- [x] Milestone 1: spec engine and CLI
- [ ] Constitution compiler and bundles
- [ ] Policy hook and managed settings
- [ ] Local service, local MCP gateway and dashboard
- [ ] Handoff (`orgspec packet`, `/orgspec-work`) and gh account management
