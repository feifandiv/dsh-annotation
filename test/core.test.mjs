/**
 * Offline tests for the pure annotation core: quote anchoring, persistence
 * normalization, list maintenance and Markdown rendering. Run with:
 *   node --test test/core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNO_COLORS,
  ANNO_MAX_QUOTE,
  ANNO_STORAGE_KEY,
  annoAnnotationText,
  annoBuildSegment,
  annoExportPayload,
  annoForDocument,
  annoForSession,
  annoFormatMarkdown,
  annoGroupDocuments,
  annoNormalizeAnnotation,
  annoNormalizeList,
  annoPatch,
  annoMarkSent,
  annoPendingAnnotations,
  annoBuildAgentPrompt,
  annoQuotePreview,
  annoReadStore,
  annoRemove,
  annoResolveSegment,
  annoUpsert,
  annoVisibleAnnotations,
  annoWriteStore,
} from '../src/core.js';

const TEXT = '第一段：DeepSeek 的回复正文可以标注。第二段：文档预览也可以标注，重复内容出现两次：标注。';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function makeChatAnnotation(overrides) {
  const start = TEXT.indexOf('文档预览');
  const segment = annoBuildSegment(TEXT, start, start + 4, { anchorKey: 'node-1', nodeKind: 'assistant-step' });
  return {
    id: 'a-1',
    color: 'yellow',
    note: '',
    createdAt: 1000,
    updatedAt: 1000,
    source: 'chat',
    sessionId: 'session-1',
    segments: [segment],
    ...overrides,
  };
}

test('builds a quote segment with prefix/suffix context', () => {
  const start = TEXT.indexOf('回复正文');
  const segment = annoBuildSegment(TEXT, start, start + 4, { anchorKey: 'k', nodeKind: 'assistant-step' });
  assert.equal(segment.exact, '回复正文');
  assert.equal(segment.anchorKey, 'k');
  assert.equal(segment.nodeKind, 'assistant-step');
  assert.ok(segment.prefix.endsWith('DeepSeek 的'));
  assert.ok(segment.suffix.startsWith('可以标注'));
  assert.equal(TEXT.slice(segment.start, segment.start + segment.exact.length), segment.exact);
});

test('rejects empty or whitespace-only selections', () => {
  assert.equal(annoBuildSegment(TEXT, 3, 3), null);
  const space = annoBuildSegment('a   b', 1, 4);
  assert.equal(space, null);
  assert.equal(annoBuildSegment(TEXT, -1, 2), null);
  assert.equal(annoBuildSegment(TEXT, 5, 2), null);
});

test('clamps an oversized selection instead of storing everything', () => {
  const long = 'x'.repeat(ANNO_MAX_QUOTE + 50);
  const segment = annoBuildSegment(long, 0, long.length);
  assert.equal(segment.exact.length, ANNO_MAX_QUOTE);
});

test('re-anchors after content is inserted before the annotation', () => {
  const start = TEXT.indexOf('文档预览');
  const segment = annoBuildSegment(TEXT, start, start + 4);
  const shifted = '新增的前置内容。' + TEXT;
  const resolved = annoResolveSegment(shifted, segment);
  assert.ok(resolved);
  assert.equal(shifted.slice(resolved.start, resolved.end), '文档预览');
});

test('disambiguates repeated quotes using surrounding context', () => {
  const firstStart = TEXT.indexOf('标注');
  const segment = annoBuildSegment(TEXT, firstStart, firstStart + 2, { anchorKey: 'k' });
  // Insert an extra occurrence of the quote earlier in the text.
  const mutated = '标注 标注 ' + TEXT;
  const resolved = annoResolveSegment(mutated, segment);
  assert.ok(resolved);
  assert.equal(mutated.slice(resolved.start, resolved.end), '标注');
  // The context match must pick the original occurrence, not the first added one.
  assert.equal(resolved.start, mutated.indexOf('标注', 8));
});

test('returns null when the annotated text disappeared', () => {
  const segment = annoBuildSegment(TEXT, 0, 3);
  assert.equal(annoResolveSegment('完全不同的内容', segment), null);
});

test('normalizes a valid chat annotation and rejects broken ones', () => {
  const annotation = annoNormalizeAnnotation(makeChatAnnotation());
  assert.ok(annotation);
  assert.equal(annotation.source, 'chat');
  assert.equal(annotation.sessionId, 'session-1');
  assert.equal(annotation.segments.length, 1);

  assert.equal(annoNormalizeAnnotation({ ...makeChatAnnotation(), sessionId: '' }), null);
  assert.equal(annoNormalizeAnnotation({ ...makeChatAnnotation(), segments: [] }), null);
  assert.equal(annoNormalizeAnnotation({ ...makeChatAnnotation(), source: 'other' }), null);
  const segmentWithoutAnchor = { exact: '文字', prefix: '', suffix: '', start: 0 };
  assert.equal(
    annoNormalizeAnnotation({ ...makeChatAnnotation(), segments: [segmentWithoutAnchor] }),
    null,
  );
  const fallbackColor = annoNormalizeAnnotation({ ...makeChatAnnotation(), color: 'chartreuse' });
  assert.equal(fallbackColor.color, 'yellow');
});

test('normalizes a valid document annotation with path', () => {
  const segment = annoBuildSegment(TEXT, 0, 4);
  const annotation = annoNormalizeAnnotation({
    id: 'doc-1',
    color: 'blue',
    source: 'document',
    docKey: 'dsh-resource://file/abc',
    path: '/tmp/notes.md',
    segments: [segment],
  });
  assert.ok(annotation);
  assert.equal(annotation.docKey, 'dsh-resource://file/abc');
  assert.equal(annotation.path, '/tmp/notes.md');
  assert.equal(annoNormalizeAnnotation({ ...annotation, docKey: '' }), null);
});

test('normalizes lists, dropping invalid entries and capping size', () => {
  const list = annoNormalizeList([
    makeChatAnnotation(),
    null,
    { source: 'chat' },
    makeChatAnnotation({ id: 'a-2' }),
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((item) => item.id),
    ['a-1', 'a-2'],
  );
});

test('round-trips annotations through a Storage-like object', () => {
  const storage = makeStorage();
  const annotation = annoNormalizeAnnotation(makeChatAnnotation());
  assert.equal(annoWriteStore(storage, [annotation]), true);
  const raw = JSON.parse(storage.getItem(ANNO_STORAGE_KEY));
  assert.equal(raw.version, 1);
  const loaded = annoReadStore(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'a-1');
});

test('reads corrupt or missing storage as empty', () => {
  const storage = makeStorage();
  assert.deepEqual(annoReadStore(storage), []);
  storage.setItem = () => {
    throw new Error('denied');
  };
  assert.deepEqual(annoReadStore(storage), []);
  const broken = makeStorage();
  broken.setItem(ANNO_STORAGE_KEY, '{not json');
  assert.deepEqual(annoReadStore(broken), []);
  const legacy = makeStorage();
  legacy.setItem(ANNO_STORAGE_KEY, JSON.stringify([makeChatAnnotation()]));
  assert.equal(annoReadStore(legacy).length, 1);
});

test('upserts newest-first, patches and removes', () => {
  const first = annoNormalizeAnnotation(makeChatAnnotation({ id: 'a-1' }));
  const second = annoNormalizeAnnotation(makeChatAnnotation({ id: 'a-2' }));
  let list = annoUpsert([first], second, 2000);
  assert.deepEqual(
    list.map((item) => item.id),
    ['a-2', 'a-1'],
  );
  list = annoPatch(list, 'a-2', { note: '重要', color: 'green' }, 3000);
  const patched = list.find((item) => item.id === 'a-2');
  assert.equal(patched.note, '重要');
  assert.equal(patched.color, 'green');
  assert.equal(patched.updatedAt, 3000);
  list = annoRemove(list, 'a-2');
  assert.deepEqual(
    list.map((item) => item.id),
    ['a-1'],
  );
  assert.equal(annoUpsert([], null).length, 0);
});

test('filters by session and document identity', () => {
  const chatA = annoNormalizeAnnotation(makeChatAnnotation({ id: 'a-1', sessionId: 's-1' }));
  const chatB = annoNormalizeAnnotation(makeChatAnnotation({ id: 'a-2', sessionId: 's-2' }));
  const segment = annoBuildSegment(TEXT, 0, 3);
  const docA = annoNormalizeAnnotation({
    id: 'd-1',
    source: 'document',
    docKey: 'key-1',
    path: '/a/b.md',
    segments: [segment],
  });
  const docB = annoNormalizeAnnotation({
    id: 'd-2',
    source: 'document',
    docKey: 'key-2',
    path: '/a/c.md',
    segments: [segment],
  });
  const all = [chatA, chatB, docA, docB];
  assert.deepEqual(
    annoForSession(all, 's-1').map((item) => item.id),
    ['a-1'],
  );
  assert.deepEqual(
    annoForDocument(all, 'key-1', null).map((item) => item.id),
    ['d-1'],
  );
  assert.deepEqual(
    annoForDocument(all, null, '/a/c.md').map((item) => item.id),
    ['d-2'],
  );
  const groups = annoGroupDocuments(all);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.path === '/a/b.md').annotations.length, 1);
});

test('formats annotations as Markdown with groups and notes', () => {
  const annotation = annoNormalizeAnnotation(
    makeChatAnnotation({ note: '这里需要展开', color: 'pink' }),
  );
  const markdown = annoFormatMarkdown([annotation], {
    title: '标注',
    group: () => '当前对话',
    noNote: '无批注',
  });
  assert.match(markdown, /^# 标注/m);
  assert.match(markdown, /^## 当前对话/m);
  assert.match(markdown, /> .*文档预览/);
  assert.match(markdown, /这里需要展开/);
  const empty = annoFormatMarkdown(
    [annoNormalizeAnnotation(makeChatAnnotation())],
    { noNote: '无批注' },
  );
  assert.match(empty, /无批注/);
});

test('derives quote previews and annotation text', () => {
  const annotation = annoNormalizeAnnotation(makeChatAnnotation());
  assert.equal(annoAnnotationText(annotation), '文档预览');
  assert.equal(annoQuotePreview(annotation, 3), '文档…');
  assert.equal(annoQuotePreview(annotation, 100), '文档预览');
});

test('exports a versioned JSON payload', () => {
  const annotation = annoNormalizeAnnotation(makeChatAnnotation());
  const payload = annoExportPayload([annotation], { title: '标注' });
  assert.equal(payload.version, 1);
  assert.equal(payload.title, '标注');
  assert.deepEqual(
    payload.annotations.map((item) => item.id),
    ['a-1'],
  );
  assert.ok(typeof payload.exportedAt === 'string');
});

test('color palette is the four supported highlight tokens', () => {
  assert.deepEqual(ANNO_COLORS, ['yellow', 'green', 'blue', 'pink']);
});


test('tracks pending annotations across chat and open documents', () => {
  const segment = annoBuildSegment(TEXT, 0, 4);
  const chat = annoNormalizeAnnotation({
    id: 'p-chat',
    source: 'chat',
    sessionId: 's-1',
    color: 'yellow',
    segments: [annoBuildSegment(TEXT, 0, 4, { anchorKey: 'k' })],
    sentAt: 5,
    updatedAt: 10,
  });
  const doc = annoNormalizeAnnotation({
    id: 'p-doc',
    source: 'document',
    docKey: 'dsh-resource://file/session/s-1/a.md',
    path: '/w/a.md',
    color: 'blue',
    segments: [segment],
    sentAt: 20,
    updatedAt: 20,
  });
  const pending = annoPendingAnnotations([chat, doc], {
    sessionId: 's-1',
    docKeys: [doc.docKey],
    docPaths: [doc.path],
  });
  assert.deepEqual(pending.map((item) => item.id), ['p-chat']);
  const marked = annoMarkSent([chat, doc], ['p-chat'], 99);
  assert.equal(marked.find((item) => item.id === 'p-chat').sentAt, 99);
  assert.equal(annoPendingAnnotations(marked, { sessionId: 's-1', docKeys: [doc.docKey], docPaths: [doc.path] }).length, 0);
});

test('builds the agent message from quotes, locations and notes', () => {
  const chat = annoNormalizeAnnotation({
    id: 'm-chat',
    source: 'chat',
    sessionId: 's-1',
    note: '这句要改短',
    color: 'yellow',
    segments: [annoBuildSegment(TEXT, 0, 4, { anchorKey: 'k' })],
  });
  const doc = annoNormalizeAnnotation({
    id: 'm-doc',
    source: 'document',
    docKey: 'dsh-resource://file/session/s-1/a.md',
    path: '/w/a.md',
    note: '',
    color: 'blue',
    segments: [annoBuildSegment(TEXT, 6, 10)],
  });
  const zh = annoBuildAgentPrompt([chat, doc], { zh: true });
  assert.match(zh, /2 处具体内容/);
  assert.match(zh, /原文：「第一段：/);
  assert.match(zh, /这句要改短/);
  assert.match(zh, /`\/w\/a.md`/);
  const en = annoBuildAgentPrompt([chat], { zh: false });
  assert.match(en, /1 specific places/);
  assert.match(en, /Quote:/);
});

test('scopes visible annotations and numbers them consistently', () => {
  const list = [
    { id: 'c-new', source: 'chat', sessionId: 's-1', createdAt: 30 },
    { id: 'old', source: 'chat', sessionId: 's-2', createdAt: 5 },
    { id: 'd-1', source: 'document', docKey: 'doc-1', createdAt: 10 },
    { id: 'c-old', source: 'chat', sessionId: 's-1', createdAt: 20 },
  ];
  const visible = annoVisibleAnnotations(list, { sessionId: 's-1' });
  assert.equal(visible.count, 3);
  assert.deepEqual(visible.chat.map((item) => item.id), ['c-old', 'c-new']);
  assert.deepEqual(visible.documents.map((item) => item.id), ['d-1']);
  assert.equal(visible.numbers.get('d-1'), 1);
  assert.equal(visible.numbers.get('c-old'), 2);
  assert.equal(visible.numbers.get('c-new'), 3);
  assert.equal(visible.numbers.has('old'), false);
});
