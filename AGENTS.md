# Agent instructions

These rules apply to every AI coding tool working in this repository (Codex, Claude Code, Cursor, Copilot, and others).

## Branches and worktrees

- Work directly on `main` in this checkout. Do not create feature branches or additional git worktrees for development unless the user explicitly asks for one.
- Before starting: `git switch main && git pull --ff-only`. If the working tree is not on `main`, or has changes you did not make, stop and ask instead of switching or discarding them.
- Commit to `main`. Push only when the user asks.
- `agent/*` and `aperture/cp-*` branches are created by the Control Plane itself when it runs a Builder; they are product behavior, not development branches. Leave them alone.

## Housekeeping

- Never commit `workbench/node_modules` (in some setups it is a symlink, which the `node_modules/` ignore pattern does not match).
- Run `npm run check` in `workbench/` before committing changes to server or client code.
