# Agent instructions

## Commit messages

- Follow `commitlint.config.ts`. The subject is `type(scope?): description`. Use lowercase and the imperative, with no period.
- Keep the subject line, every body line and every footer line at 100 characters or fewer. CI fails `header-max-length`, `body-max-line-length` and `footer-max-line-length` on longer lines.
- Lint before the first push: `npx commitlint --from origin/main --to HEAD`.
- CI lints every commit on the PR. A bad message cannot be fixed without a force-push, and force-pushes are blocked. Get the message right before pushing.
- Never rewrite pushed history.

## Lockfile

- The root `overrides` pin `typescript` to `^5.9.0` because `rollup-plugin-dts` crashes on TS7.
- Keep the workspace `typescript` ranges at `^5.9.0` so `npm ci` stays in sync on npm 10.
- Check with `npm ci --dry-run` after any dependency change.
