# Skill Hub Security Checklist

## Authentication

- Built-in passwords are stored with PBKDF2 hashes and per-user salts.
- Session cookies are httpOnly and SameSite=Lax.
- `SESSION_SECRET` must be a long random value in production.
- Admin-only endpoints must use both authentication and role checks.

## Upload Safety

- Only zip packages are accepted.
- Zip packages must contain exactly one `SKILL.md`.
- Absolute paths, `..` path segments, null bytes, and symlinks are rejected.
- File count, package size, and per-file size are limited.
- Uploaded packages are parsed and scanned only; scripts are never executed during review.

## GitHub Safety

- GitHub access uses a GitHub App, not a personal access token.
- Import reads the requested source repo/path/ref and stores the source commit SHA.
- Publish sync writes only to configured `PUBLISH_REPO`.
- Publish commit SHA is recorded on the version.
- Missing GitHub configuration must fail closed for import and sync.

## Review Controls

- Member users can create versions and submit their own versions for review.
- Admin users can approve, reject, publish, sync, archive, and create users.
- Rejections must include a reason.
- Publish marks a version as `published` only after GitHub sync succeeds.
- Failed sync keeps the version `approved` and records the error.

## Audit

- Log login, user creation, version creation, review transitions, publication, and archive events.
- Do not include secrets or raw private keys in audit metadata.

