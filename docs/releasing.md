# Releasing

`mcpsignals` is released automatically. Nothing is versioned, tagged or published by hand
after the one-time bootstrap below.

## How a release happens

1. Commits land on `main` using [Conventional Commits](https://www.conventionalcommits.org/).
2. The `Release` workflow runs, waits for approval on the `npm-publish` environment, and
   hands off to [semantic-release](https://semantic-release.gitbook.io/).
3. semantic-release reads the commits since the last `v*` tag, decides the next version,
   publishes `packages/node` to npm over OIDC, pushes the tag, and writes the GitHub release
   notes.

Commit types map to versions like this:

| Commit type                      | Version bump |
| -------------------------------- | ------------ |
| `feat`                           | minor        |
| `fix`, `perf`                    | patch        |
| `feat!` / `BREAKING CHANGE:`     | major        |
| everything else                  | no release   |

`commitlint` enforces the type list in CI and in the local `commit-msg` hook, so a typo in a
commit type fails fast instead of silently producing no release.

### The first automated release is 1.0.0

`0.1.0` exists on npm but was published by hand, purely to bootstrap trusted publishing. No
git tag was ever created for it, and semantic-release determines the previous release
**only** from git tags - it never reads the registry. With no tag to continue from it treats
the next release as the first one, and the first release is hardcoded to `1.0.0` in
`semantic-release/lib/definitions/constants.js`. There is no setting to change it.

That is deliberate here: seeding a tag by hand to preserve `0.x` would mean hand-maintaining
the very thing semantic-release exists to own. So `0.1.0` stands as a bootstrap artifact,
the first automated release is `1.0.0`, and every tag from that point on is created by
semantic-release.

Plain semver applies from there: `fix` and `perf` give `1.0.1`, `feat` gives `1.1.0`, and a
`feat!` or `BREAKING CHANGE:` footer gives `2.0.0`. Publishing `1.0.0` is a statement that
the API is stable, so treat breaking changes accordingly.

## Publishing credentials

There are none, and none should ever be added.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the
workflow requests a short-lived OIDC token from GitHub and npm verifies it against the
trusted publisher registered for the package. Provenance attestations are generated
automatically as a result.

> **Never set `NPM_TOKEN` or `NODE_AUTH_TOKEN` in this repository.** If npm finds a token in
> the environment it falls back to the legacy token flow and skips OIDC entirely. This also
> matters because npm granular access tokens lose the ability to publish in January 2027.

Three values must match exactly between the npm trusted publisher configuration and this
repo, and npm does not validate them when you save:

| npm field         | Value                          |
| ----------------- | ------------------------------ |
| Repository        | `zentered-studios/mcpsignals`  |
| Workflow filename | `release.yml`                  |
| Environment       | `npm-publish`                  |

If `.github/workflows/release.yml` is ever renamed, or the environment is renamed or
removed, update the npm side at the same time or every publish will fail.

## One-time bootstrap

npm cannot register a trusted publisher for a package that does not exist yet, so the very
first version has to be published by hand. This is done once, from a laptop, with 2FA - no
long-lived token is created anywhere.

**This has already been done for `mcpsignals`** - it is recorded here for reference, and for
any future package published out of this repository.

1. Create the `npm-publish` environment in **Settings -> Environments** and add yourself as a
   required reviewer.

2. From a clean checkout of `main`:

   ```sh
   npm ci
   npm run build --workspace packages/node
   npm test --workspace packages/node
   npm publish --workspace packages/node
   ```

   npm will prompt for a one-time password. This first version has no provenance attestation;
   every later release does.

3. Register the trusted publisher (needs npm >= 11.15.0 and 2FA on the account):

   ```sh
   npm trust github mcpsignals \
     --repo zentered-studios/mcpsignals \
     --file release.yml \
     --env npm-publish \
     --allow-publish
   ```

   Verify it with `npm trust list mcpsignals`.

That is the whole bootstrap. No tag is created by hand - see
[The first automated release is 1.0.0](#the-first-automated-release-is-100). From here on,
merging a `feat` or `fix` into `main` releases automatically, and semantic-release creates
every tag.

> Once `1.0.0` is released, its tag is what every later version is computed from. If the
> repository's history is ever rewritten or the repository recreated, the tags go with it and
> semantic-release will try to publish `1.0.0` again - which npm rejects, because a published
> version can never be reused. Check `git ls-remote --tags origin` before assuming a release
> will work.

## Troubleshooting

### `Missing helper: "conventional-changelog-conventionalcommits requires ..."`

The `conventionalcommits` preset and the changelog writer are on incompatible majors.

`@semantic-release/release-notes-generator@14` depends on `conventional-changelog-writer@^8`,
while preset **v10** dropped support for writer 8 (it renders through
`@conventional-changelog/template` instead). The preset is therefore pinned to **`^9.3.1`** in
the root `package.json`.

Do not bump `conventional-changelog-conventionalcommits` to 10 or later until
`@semantic-release/release-notes-generator` depends on `conventional-changelog-writer@^9` or
newer. An automated dependency bump will happily reintroduce this. Note that
`semantic-release --dry-run` does **not** catch it when run from a non-release branch: it
exits at the branch check before ever rendering notes.

### `EINVALIDNPMTOKEN Invalid npm token`

This error points at the wrong thing. **Do not add an `NPM_TOKEN` in response to it.**

`@semantic-release/npm` tries the OIDC exchange first and only falls back to token
authentication when that exchange does not succeed. The fallback then complains about a
missing or invalid token, even though no token was ever meant to exist.

Look further up the log for the real reason:

```
Verifying OIDC context for publishing from GitHub Actions
OIDC token exchange with the npm registry failed: 404 OIDC token exchange error - package not found
```

Common causes, in order of likelihood:

- **The package is not on the registry.** A trusted publisher cannot exist for a package that
  has never been published. Run the bootstrap above.
- **The trusted publisher does not match.** Repository, workflow filename (`release.yml`) and
  environment (`npm-publish`) are all case-sensitive, and npm does not validate them when
  saved. Check with `npm trust list mcpsignals`.
- **`id-token: write` is missing** from the job. The log then says
  `Retrieval of GitHub Actions OIDC token failed` instead of reporting a failed exchange.

### The release fails during the `fail` step

`@semantic-release/github` opens an issue when a release fails. If that issue carries a label
the repository does not have, GitHub rejects it with
`422 Validation Failed ... resource: Label`, and that error masks whatever actually broke.
Labels are disabled in `.releaserc.json` for this reason.

## Local tooling

| Command                | What it does                            |
| ---------------------- | --------------------------------------- |
| `npm run format`       | Format with Biome                       |
| `npm run format:check` | Fail if anything is unformatted         |
| `npm run lint`         | Lint with oxlint                        |

Biome formats, oxlint lints. They are deliberately not both linting, so a finding is only
ever reported by one tool.

Git hooks are installed by husky on `npm install`: `pre-commit` runs Biome and oxlint,
`commit-msg` runs commitlint.

## Dependency audit

`npm audit` reports advisories inside `node_modules/npm`, which `@semantic-release/npm`
vendors for its own use. They are build-time only and never reach the published tarball -
the package ships `dist` and has no runtime dependencies.

> **Do not run `npm audit fix --force`.** It downgrades semantic-release to 24.x, which
> predates trusted publishing support and would break releases.

Dependency install scripts are blocked by default under npm 12. The build does not need any
of them; if a future dependency genuinely does, add it to an `allowScripts` entry rather
than disabling the protection wholesale.
