# Contributing

Thanks for your interest in improving `dsh-annotation`.

## Development setup

Only Node.js is required (no dependencies to install):

```bash
git clone https://github.com/feifandiv/dsh-annotation.git
cd dsh-annotation
node build.mjs
node --test test/core.test.mjs
node test/smoke.mjs
node tools/validate.mjs
```

`client.js` is a generated artifact committed to the repository. Edit `src/*.js`
and run `node build.mjs`; CI verifies that the committed bundle matches the
sources.

## Project layout

| Path | Role |
| --- | --- |
| `src/core.js` | Pure model: quote anchoring, persistence, pending/send, prompt formatting |
| `src/engine.js` | DOM engine: selection capture, re-anchoring, CSS highlights, listeners |
| `src/ui.js` | React surfaces registered into slots (composer, pins, send bar, panel) |
| `src/strings.js` | Runtime zh/en dictionaries |
| `src/plugin.js` | Client plugin body and slot registrations |
| `build.mjs` | Concatenates `src/*.js` into the browser bundle `client.js` |
| `test/` | Pure-logic tests and a bundle/loader smoke test |
| `tools/` | Offline manifest/locale/icon/bundle validator |

## Guidelines

- Keep the plugin additive: register fresh entry ids in existing slots, never
  replace shipped UI.
- Do not import Harness Client packages at runtime; the bundle only requires
  `react` from the host module table.
- Avoid inserting DOM into React-owned text; highlight with the CSS Custom
  Highlight API.
- Keep annotations recoverable: preserve `exact/prefix/suffix/start` in stored
  segments and add a test when the anchoring algorithm changes.
- Every user-visible string should go through `src/strings.js` (zh + en).
- Run `node build.mjs && node test/smoke.mjs && node tools/validate.mjs` before
  opening a pull request, and include the generated `client.js` change.
- Do not include personal data, absolute local paths, or credentials in code,
  docs, or tests.

## Reporting issues

Please include the DSH version, your OS, a short reproduction, and the output of
`__dshAnnotation.probe()` from the browser console when relevant. Screenshots
are welcome.
