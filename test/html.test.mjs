/**
 * Pure tests for the annotatable HTML renderer's offline half: address decoding,
 * reference admission, base64 inlining and the serialized bridge.
 *
 * The bridge itself runs inside an iframe document, so it is exercised in the
 * browser; here we only prove it serializes without ESM syntax and carries the
 * message contract the parent listens for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annoHtmlAppendBridge,
  annoHtmlBase64,
  annoHtmlBridgeMain,
  annoHtmlBridgeScript,
  annoHtmlDecode,
  annoHtmlFileScope,
  annoHtmlRelativeReference,
} from '../src/html.js';
import { ANNO_COLORS } from '../src/core.js';

test('decodes session and absolute file addresses', () => {
  assert.deepEqual(
    annoHtmlFileScope('dsh-resource://file/session/s-1/Users/me/report.html'),
    { sessionId: 's-1', path: 'Users/me/report.html' },
  );
  assert.deepEqual(
    annoHtmlFileScope('dsh-resource://file/session/s%201/a%20b/page.html?x=1#top'),
    { sessionId: 's 1', path: 'a b/page.html' },
  );
  assert.equal(annoHtmlFileScope('dsh-resource://file/absolute/Users/me/page.html'), null);
  assert.equal(annoHtmlFileScope('https://example.com/a.html'), null);
  assert.equal(annoHtmlFileScope('dsh-resource://file/session//x.html'), null);
});

test('admits only sibling references the frame may inline', () => {
  assert.equal(annoHtmlRelativeReference('style.css'), true);
  assert.equal(annoHtmlRelativeReference('js/app.js'), true);
  assert.equal(annoHtmlRelativeReference('https://cdn.example.com/a.js'), false);
  assert.equal(annoHtmlRelativeReference('//cdn.example.com/a.js'), false);
  assert.equal(annoHtmlRelativeReference('/absolute/a.css'), false);
  assert.equal(annoHtmlRelativeReference('#fragment'), false);
  assert.equal(annoHtmlRelativeReference(''), false);
});

test('encodes asset bytes as base64 in bounded chunks', () => {
  assert.equal(annoHtmlBase64(new Uint8Array([104, 105])), 'aGk=');
  const big = new Uint8Array(70000);
  big[0] = 1;
  big[69999] = 2;
  const encoded = annoHtmlBase64(big);
  assert.equal(encoded.length, Math.ceil(70000 / 3) * 4);
  assert.equal(Buffer.from(encoded, 'base64').length, 70000);
});

test('decodes complete HTML and rejects invalid UTF-8', () => {
  assert.equal(annoHtmlDecode(new TextEncoder().encode('<p>你好</p>')), '<p>你好</p>');
  assert.throws(() => annoHtmlDecode(new Uint8Array([0xff, 0xfe, 0x00])));
});

test('appends a self-contained bridge script to the document', () => {
  const html = annoHtmlAppendBridge('<p>hi</p>');
  assert.ok(html.startsWith('<p>hi</p><script>('));
  assert.ok(html.includes("dsh-annotation-html"));
  assert.ok(html.includes(ANNO_COLORS[0]));
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
});

test('the bridge serializes as plain script source', () => {
  const source = annoHtmlBridgeMain.toString();
  assert.ok(source.startsWith('function annoHtmlBridgeMain(config)'));
  assert.equal(/\bexport\b/.test(source), false);
  assert.equal(/\bimport\b/.test(source), false);
  // The parent listens on this namespace and these message types.
  const script = annoHtmlBridgeScript();
  for (const token of ['dsh-annotation-html', "'ready'", "'selection'", "'paint'", "'hit'", "'dismiss'"]) {
    assert.ok(script.includes(token), 'bridge should mention ' + token);
  }
});

test('the serialized bridge compiles as classic script', () => {
  const script = annoHtmlBridgeScript();
  const start = script.indexOf('<script>') + '<script>'.length;
  const end = script.lastIndexOf('</script>');
  assert.ok(start > 0 && end > start);
  const code = script.slice(start, end);
  assert.doesNotThrow(() => new Function(code));
});
