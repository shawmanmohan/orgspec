# Constitution: engineer 1.0.0
Compiled from the organisation’s Confluence pages and approved by a process owner. Rules marked enforced are checked by hooks or CI; advisory rules are guidance.
## Enforced by hooks

### No force pushes (`eng.git.no-force-push`)

Never force-push; add commits or open a new branch.

Source: page 100001 v1 — "Never force-push to a branch someone else may have pulled"

### Open pull requests as drafts (`eng.git.draft-prs`)

Open pull requests as drafts; a person marks them ready.

Source: page 100001 v1 — "pull requests start as drafts"

### CI workflows change only with a spec (`eng.ci.workflows-in-spec`)

Change .github/workflows only when the change folder names the file.

Source: page 100002 v1 — "Pipeline definitions change only through a reviewed change"

## Enforced in CI

### Migrations are high tier (`eng.tier.migrations-high`)

Changes under db/migrations need a high-tier change.

Source: page 100002 v1 — "Schema migrations are always high risk"

### Scenarios are tested (`eng.trace.scenarios`)

Every new or changed scenario is cited by a test at medium and high tier.

Source: page 100001 v1 — "every behaviour change ships with a test"

### High-tier designs need a staff engineer (`eng.design.approval`)

A staff engineer approves design.md for high-tier changes.

Source: page 100002 v1 — "High-risk designs are approved by a staff engineer"

### No secrets in code (`eng.secrets.none`)

Never commit credentials.

Source: page 100001 v1 — "Credentials never go into source control"

## Review rubric

### Designs explain rollback (`eng.design.rollback`)

design.md says how to roll the change back.

Source: page 100002 v1 — "Describe how you would roll back"
