# Agent Team Repository Rules

## Shared constraints

- Follow the task-specific `allowedPaths` and `blockedPaths` exactly.
- Never expose secrets or copy credentials into source files or logs.
- Never push, deploy, modify production resources, or execute destructive migrations from an autonomous task.
- Do not edit `package.json`, lockfiles, global routes, migrations, or shared architecture documents unless the assigned task explicitly owns them.
- Prefer the smallest change that closes the acceptance criteria.
- Add tests for boundary, error, permission, and data-integrity behavior where relevant.

## Git ownership

- Workers do not stage or commit. The Runner performs mechanical verification, staging, review, and commit.
- Reviewers are read-only.
- Integrators only resolve named conflicts or update explicitly allowed integration documentation.
