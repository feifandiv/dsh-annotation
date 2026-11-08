# annotation/tools — offline validation tooling

Deterministic, **offline** checks for the `annotation` Harness bundle (highlight +
note on assistant replies and right-sidebar document previews). Nothing here
touches the network, installs packages, activates the plugin, or calls
`plugin_manager`.

| File | Purpose |
| --- | --- |
| `validate.mjs` | Zero-dependency Node validator. Exits non-zero with readable errors. |
| `selfcheck.sh` | Runs `../build.mjs` (when present) then `validate.mjs`, prints a PASS/FAIL summary. |
| `README.md` | This file. |

## How to run

Use the runtime's bundled Node (same binary the Harness uses):

```sh

# full check: build (if annotation/build.mjs exists) + validate
annotation/tools/selfcheck.sh

# validate only, current files as-is
node annotation/tools/validate.mjs
annotation/tools/selfcheck.sh --skip-build

# machine-readable / quieter output
node annotation/tools/validate.mjs --json
node annotation/tools/validate.mjs --quiet

# validate a different bundle directory
node annotation/tools/validate.mjs --dir path/to/bundle
```

`selfcheck.sh` resolves Node from `$DSH_NODE`, then the path above, then `node`
on `PATH`. All flags except `--skip-build` are forwarded to `validate.mjs`.

Exit codes: `0` all checks passed (warnings allowed), `1` at least one error,
`2` usage or bundle-directory problem. Warnings never fail the run.

`validate.mjs` reports a **missing file** as a precise error and keeps checking,
so a half-written bundle still produces the full checklist instead of crashing.
Run `--help` for the flag list.

## What `validate.mjs` checks

All rules come from the shipped plugin docs
(`skills/cordis-plugin-development/references/host-plugin.md` and
`ui-plugin.md`, `templates/decoration/`).

**`package.json`**
- parses; `name` is a valid package name, `version` is semver, `type` is `module`
- `exports` is a subpath map with `"."` → host entry, `"./client"` →
  browser module, `"./locale/*.json"`, and `"./icon"` (or a top-level `icon`);
  every literal target is a package-relative path that exists
- `files` is a non-empty array of package-relative entries and covers **every
  runtime file that exists** (host entry, client module, patch, locales, icon);
  stale / dev-only entries are warned about
- `dsh.bundle.patch` points at an existing file
- `dsh.client.platform` is `"web"`, `dsh.client.inject` is a non-empty array of
  package names, `immediately` is boolean, `external` is an array when present

**`cordis.patch.yml`**
- parses with a hand-written YAML subset (block arrays/maps, comments, quotes,
  flow `{}`/`[]`, `!!js`, block scalars) and is a **top-level array**
- has an `insert` row whose entries carry non-empty `id` + `name`, ids are
  unique, and one insert row's `name` equals the package name
- unknown top-level operation keys and non-kebab ids are warnings

**`locale/*.json`**
- every file parses and exposes non-empty `meta.title` and `meta.description`
- `locale/en.json` exists; all locales share an identical flattened key set
- locales must not reuse template copy (`"My Decoration"`) and must not share
  identical `meta.title` **and** `meta.description` across locales

**`icon`**
- path comes from `package.json` `icon` (priority) or `exports["./icon"]`,
  stays inside the package, is a regular file, ≤ 256 KiB
- by extension: SVG must have an `<svg>` root and a 4-number `viewBox`, no
  `<script>` and no external `href`; PNG/JPEG/WebP magic bytes are verified

**`client.js`** (browser module)
- starts with `window.__ModuleLoader__.load({` and its `id` equals the package
  name; exposes `factory(require)` (method, function or arrow form)
- no ESM `import` / `export` statements (dynamic `import()` is allowed)
- balanced `()`, `[]`, `{}` heuristic that ignores comments, strings, template
  literals and regex literals
- `node --check` passes in classic-script mode (fed through stdin, no temp
  files); non-baseline `require(...)` names must appear in `dsh.client.external`

**`index.js`** (host entry)
- exports `apply` (`export function apply`, `export const apply`, or
  `export { apply }`), uses no browser-only globals (`window`, `document`, …)
- `node --check` passes in ES-module mode; bare non-relative imports are warned
  about because the bundle declares no dependencies

**`build.mjs`** (optional)
- presence is reported; when present it must pass `node --check` (ES module)

## Installation is Lead-only

This tooling **never installs anything**. Installing, activating, replacing or
removing the bundle is the Team Lead's job through `plugin_manager`
(`install_bundle` / `set_plugin` / `remove_bundle`) with the user's approval
where required. Validation passing does not prove the plugin renders; the Lead
verifies installation state, metadata, and the live UI separately.
