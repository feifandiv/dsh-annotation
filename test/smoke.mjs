/**
 * Module smoke test: executes the generated browser bundle in a stubbed
 * environment to catch load-time and apply-time errors (undefined names,
 * bad registration options, throwing effect bodies) without a browser.
 *
 * This is NOT a DOM or visual test; it only proves the bundle parses, the
 * factory returns a valid client plugin, and `apply` registers its slots.
 * Run: node test/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

const appended = [];
const listeners = new Map();
const storage = new Map();

const head = {
  appendChild(node) {
    appended.push(node);
  },
};

const styleElement = () => ({
  attributes: {},
  textContent: '',
  setAttribute(name, value) {
    this.attributes[name] = value;
  },
  remove() {},
});

const documentStub = {
  head,
  documentElement: { nodeType: 1 },
  addEventListener(type, handler) {
    listeners.set('doc:' + type, handler);
  },
  removeEventListener(type) {
    listeners.delete('doc:' + type);
  },
  createElement(tag) {
    if (tag === 'style') return styleElement();
    return { tagName: String(tag).toUpperCase(), style: {}, appendChild() {}, remove() {} };
  },
  querySelectorAll() {
    return [];
  },
  createRange() {
    return {
      setStart() {},
      setEnd() {},
      collapse() {},
      collapse() {},
      selectNodeContents() {},
      cloneRange() {
        return this;
      },
      compareBoundaryPoints() {
        return 0;
      },
      comparePoint() {
        return -1;
      },
      getClientRects() {
        return [];
      },
      collapsed: true,
    };
  },
  createTreeWalker() {
    return { nextNode: () => false, currentNode: null };
  },
};

const windowStub = {
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  },
  addEventListener(type, handler) {
    listeners.set('win:' + type, handler);
  },
  removeEventListener(type) {
    listeners.delete('win:' + type);
  },
  setTimeout: (fn, ms, ...args) => {
    const timer = globalThis.setTimeout(fn, ms, ...args);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  },
  clearTimeout: globalThis.clearTimeout,
  getSelection() {
    return null;
  },
};

const registrations = [];
const localeRegistrations = [];

const ctx = {
  effect(callback) {
    return callback();
  },
  on() {},
  get() {
    return null;
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      return () => {};
    },
    bind() {
      return (key, params) => {
        const base = String(key);
        if (!params) return base;
        return base.replace(/\{(\w+)\}/g, (_, name) => String(params[name] === undefined ? '' : params[name]));
      };
    },
  },
  slots: {
    inject(owner, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ owner: options.name, options, component });
      return () => {};
    },
  },
};

const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState() {
    return [undefined, () => {}];
  },
  useEffect() {},
  useRef() {
    return { current: null };
  },
};

let loaded = null;
const sandbox = {
  window: windowStub,
  document: documentStub,
  navigator: {},
  CSS: undefined,
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  NodeFilter: { SHOW_TEXT: 4 },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  Highlight: undefined,
  Range: undefined,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  Blob: class {},
  console,
  setTimeout: (fn, ms, ...args) => {
    const timer = globalThis.setTimeout(fn, ms, ...args);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  },
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: (fn) => {
    const timer = globalThis.setTimeout(fn, 0);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  },
};
sandbox.window.__ModuleLoader__ = {
  load(options) {
    loaded = options;
  },
};
sandbox.window.document = documentStub;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.ok(loaded !== null, 'client.js must call window.__ModuleLoader__.load');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(loaded.id, pkg.name, 'module id must be the package name');
assert.equal(typeof loaded.factory, 'function', 'module must expose a factory');
const plugin = loaded.factory(() => ReactStub);
assert.ok(plugin && typeof plugin.apply === 'function', 'factory must return apply');
assert.ok(Array.isArray(plugin.inject), 'factory must return an inject list');
assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['slots', 'locale', 'sessions']));
plugin.apply(ctx);

const owners = registrations.map((entry) => entry.owner);
assert.equal(JSON.stringify(owners.sort()), JSON.stringify(['conversation.input.overlay', 'shell.overlay', 'sidebar.footer.action', 'sidebar.right.pane.tab']));
const overlay = registrations.find((entry) => entry.owner === 'shell.overlay');
assert.equal(typeof overlay.component, 'function');
assert.equal(typeof overlay.options.inject, 'function');
const injected = overlay.options.inject();
assert.ok(injected.runtime && typeof injected.runtime.repaint === 'function');
assert.equal(localeRegistrations.length, 1);
assert.ok(localeRegistrations[0].dictionaries.zh && localeRegistrations[0].dictionaries.en);
assert.equal(typeof sandbox.window.__dshAnnotation, 'object');


// ---------------------------------------------------------------------------
// Render-level smoke: execute every component body once with a tiny renderer
// so a missing identifier or a bad property access fails here, not in the app.
// ---------------------------------------------------------------------------
const runtime = injected.runtime;
const t = (key, params) => {
  if (!params) return String(key);
  return String(key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] === undefined ? '' : params[name]));
};
function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return node;
  const props = Object.assign({}, node.props);
  const children = node.children || [];
  if (children.length === 1) props.children = children[0];
  else if (children.length > 1) props.children = children;
  if (node.type === ReactStub.Fragment) return renderNode(children);
  if (typeof node.type === 'function') return renderNode(node.type(props));
  return node;
}
const payload = {
  source: 'chat',
  sessionId: 'session-smoke',
  rect: { left: 120, top: 220, right: 320, bottom: 240, width: 200, height: 20 },
  text: '文档预览',
  segments: [{ exact: '文档预览', prefix: '', suffix: '也可以标注', start: 0, anchorKey: 'node-smoke', nodeKind: 'assistant-step' }],
};
runtime.state.toolbar = payload;
assert.doesNotThrow(() => renderNode(overlay.component({ runtime, t, useSessions: null })), 'overlay idle/toolbar render must not throw');
runtime.setCurrentSession('session-smoke');
const committed = runtime.commitAnnotation('smoke note');
assert.ok(committed && committed.id, 'commitAnnotation must store an annotation from a captured payload');
assert.equal(runtime.state.toolbar, null, 'committing closes the inline composer');
runtime.setEditor({ id: committed.id, anchor: null });
assert.doesNotThrow(() => renderNode(overlay.component({ runtime, t, useSessions: null })), 'overlay with editor must not throw');
assert.ok(runtime.state.editor && runtime.state.editor.id === committed.id, 'editor state is renderable');
runtime.state.toolbar = payload;
runtime.state.panel = { rect: { left: 20, top: 600, right: 40, bottom: 620, width: 20, height: 20 } };
runtime.state.notice = 'copied';
assert.doesNotThrow(() => renderNode(overlay.component({ runtime, t, useSessions: null })), 'overlay with toolbar/panel/notice must not throw');
const pendingRegistration = registrations.find((entry) => entry.owner === 'conversation.input.overlay');
assert.doesNotThrow(() => renderNode(pendingRegistration.component({ runtime, t })), 'pending card render must not throw');
const sidebarRegistration = registrations.find((entry) => entry.owner === 'sidebar.right.pane.tab');
assert.doesNotThrow(() => renderNode(sidebarRegistration.component({ runtime, t })), 'sidebar list render must not throw');
const footerRegistration = registrations.find((entry) => entry.owner === 'sidebar.footer.action');
assert.doesNotThrow(() => renderNode(footerRegistration.component({ runtime, t, wide: true })), 'footer action render must not throw');
assert.doesNotThrow(() => renderNode(footerRegistration.component({ runtime, t, wide: false })), 'rail footer action render must not throw');
runtime.state.toolbar = null;
runtime.state.editor = null;
runtime.state.panel = null;
runtime.state.notice = null;
assert.doesNotThrow(() => renderNode(overlay.component({ runtime, t, useSessions: null })), 'overlay empty render must not throw');
const probe = sandbox.window.__dshAnnotation.probe();
assert.equal(probe.engineAttached, true);
assert.equal(probe.styleInjected, true);
assert.ok(probe.annotations >= 1);
assert.equal(typeof sandbox.window.__dshAnnotation.captureNow, 'function');

console.log('smoke OK: ' + registrations.length + ' slot registrations, stylesheet injected, locale registered, components rendered');
