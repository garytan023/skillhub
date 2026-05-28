# Skill Hub Architecture

## Scope

Skill Hub only manages Skill packages and their release lifecycle. It does not manage LLM tokens, model gateways, MCP routing, or runtime execution.

## Runtime

```text
Browser UI
  -> Express API
  -> PostgreSQL metadata
  -> Docker volume package storage
  -> GitHub App API for repo import and publish sync
```

## Data Model

- `users`: built-in accounts, role, team, password hash.
- `skills`: stable Skill identity, slug, name, owner team.
- `skill_versions`: uploaded/imported version metadata, source, scan result, status, publish sync state.
- `review_events`: submit/approve/reject/publish/archive history.
- `audit_logs`: security and admin audit trail.

## Lifecycle

```text
draft -> review -> approved -> published
       -> rejected
published -> archived
```

Only admins can approve, reject, publish, sync to GitHub, archive, and create users.

## Package Rules

- Zip uploads must contain exactly one `SKILL.md`.
- `skill.manifest.json` is optional.
- Paths must be relative and cannot contain `..`.
- Symlinks are rejected.
- Files and packages are size-limited.
- Packages are parsed and scanned, never executed.

## GitHub Integration

GitHub integration requires a GitHub App. Source repo imports read a tree/blob snapshot from the requested repo/path/ref. Publishing writes only to the configured `PUBLISH_REPO` under `skills/{skill_slug}/`.

