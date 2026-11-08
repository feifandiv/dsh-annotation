# Releasing

Package: `@feifandiv/dsh-annotation` · Repository: <https://github.com/feifandiv/dsh-annotation>

## 1. Build and verify

```bash
node build.mjs
node --check client.js
node --test test/core.test.mjs
node test/smoke.mjs
node tools/validate.mjs
```

## 2. Publish to npm

```bash
npm login
npm publish --access public
npm view @feifandiv/dsh-annotation version
```

The scoped package must be public; `publishConfig.access` is already set.

## 3. Verify a clean install

```bash
dsh plugin --profile <test-profile> add @feifandiv/dsh-annotation
```

## 4. Submit to the community catalog

The DSH market reads <https://awesome-dsh-plugin.com/plugins.json>, generated from
<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>. Add one file at
`data/plugins/feifandiv__dsh-annotation.yml`:

```yaml
url: https://github.com/feifandiv/dsh-annotation
name: feifandiv/dsh-annotation
category: ui
description:
  en: Inline annotations for DeepSeek Harness replies and sidebar documents, with a composer card and a right-sidebar list.
  zh: 给 DeepSeek Harness 的回复和侧边栏文档加划词标注，聚合成输入框卡片并一键发给 AI，右侧边栏可查看列表。
```

Then open a PR. Requirements checked by CI:

- the repo declares a `dsh.bundle` manifest (`package.json` → `dsh.bundle.patch`); this repo does;
- the repo is at least one day old;
- the repo carries the `dsh-plugin` GitHub topic.

After merge, the market catalog refreshes and the plugin appears in DSH's Discover tab
(`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`).
