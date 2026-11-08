/**
 * Pure annotation model shared by the browser half and the offline tests.
 *
 * Nothing here touches the DOM, React or localStorage directly: extraction
 * (DOM) lives in `engine.js`, persistence passes a storage-like object in.
 * The core owns the persisted shape and the quote-anchoring algorithm, which
 * is the part most worth testing without a browser.
 */

/** Highlight colors, in toolbar order. Each maps to a theme token in CSS. */
export const ANNO_COLORS = ['yellow', 'green', 'blue', 'pink'];

/** localStorage key holding every annotation of this profile. */
export const ANNO_STORAGE_KEY = 'dsh.annotation.v1';

/** Persisted-envelope version; bump only when the stored shape changes. */
export const ANNO_STORE_VERSION = 1;

/** Characters of surrounding context stored per segment for re-anchoring. */
export const ANNO_QUOTE_CONTEXT = 42;

/** Caps keep a hostile or accidental page from growing storage without bound. */
export const ANNO_MAX_QUOTE = 4000;
export const ANNO_MAX_NOTE = 4000;
export const ANNO_MAX_SEGMENTS = 40;
export const ANNO_MAX_ANNOTATIONS = 5000;

/** Monotonic-enough local time for sorting; tests may pass an explicit value. */
export function annoNow() {
  return Date.now();
}

/** Identifier for a new annotation. */
export function annoMakeId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return 'a-' + globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through to the Math.random form */
  }
  return 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Coerce any value to a bounded string. */
export function annoClampText(value, max) {
  if (typeof value !== 'string' || value === '') return '';
  const clean = value.replace(/\u0000/g, '');
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Length of the common prefix of two strings. */
export function annoCommonPrefixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/** Length of the common suffix of two strings. */
export function annoCommonSuffixLen(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

/**
 * Build the stored quote selector for one selected range.
 *
 * @param {string} text canonical root text (same extraction is reused on read)
 * @param {number} start start offset in that text
 * @param {number} end end offset (exclusive)
 * @param {{anchorKey?: string, nodeKind?: string}} [extra] root identity hints
 * @returns {{exact: string, prefix: string, suffix: string, start: number, anchorKey?: string, nodeKind?: string} | null}
 */
export function annoBuildSegment(text, start, end, extra) {
  if (typeof text !== 'string') return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > text.length) return null;
  const raw = text.slice(start, end);
  if (raw.trim() === '') return null;
  const exact = annoClampText(raw, ANNO_MAX_QUOTE);
  const seg = {
    exact,
    prefix: text.slice(Math.max(0, start - ANNO_QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + ANNO_QUOTE_CONTEXT),
    start,
  };
  if (extra && typeof extra.anchorKey === 'string' && extra.anchorKey) seg.anchorKey = extra.anchorKey;
  if (extra && typeof extra.nodeKind === 'string' && extra.nodeKind) seg.nodeKind = extra.nodeKind;
  return seg;
}

/**
 * Find one stored quote in the current root text.
 *
 * Every occurrence of `exact` is scored by how much of the stored prefix and
 * suffix still surrounds it; the stored offset breaks ties. This tolerates
 * content inserted before or after the annotation (streaming, pagination,
 * folded rows) as long as the annotated text itself is unchanged.
 *
 * @param {string} text current root text
 * @param {{exact: string, prefix?: string, suffix?: string, start?: number}} segment
 * @returns {{start: number, end: number} | null}
 */
export function annoResolveSegment(text, segment) {
  if (typeof text !== 'string' || !segment || typeof segment.exact !== 'string') return null;
  const exact = segment.exact;
  if (exact === '') return null;
  const prefix = typeof segment.prefix === 'string' ? segment.prefix : '';
  const suffix = typeof segment.suffix === 'string' ? segment.suffix : '';
  const hint = Number.isInteger(segment.start) && segment.start >= 0 ? segment.start : -1;
  let best = null;
  let from = 0;
  let seen = 0;
  while (seen < 200) {
    const index = text.indexOf(exact, from);
    if (index < 0) break;
    seen += 1;
    const before = text.slice(Math.max(0, index - prefix.length), index);
    const after = text.slice(index + exact.length, index + exact.length + suffix.length);
    let score = annoCommonSuffixLen(prefix, before) + annoCommonPrefixLen(suffix, after);
    if (index === hint) score += 0.5;
    if (best === null || score > best.score) {
      best = { start: index, end: index + exact.length, score };
    }
    from = index + Math.max(1, exact.length);
  }
  return best === null ? null : { start: best.start, end: best.end };
}

function annoFinite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Normalize a persisted segment, dropping anything unusable. */
export function annoNormalizeSegment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const exact = annoClampText(raw.exact, ANNO_MAX_QUOTE);
  if (exact === '' || exact.trim() === '') return null;
  const segment = {
    exact,
    prefix: annoClampText(raw.prefix, ANNO_QUOTE_CONTEXT),
    suffix: annoClampText(raw.suffix, ANNO_QUOTE_CONTEXT),
    start: Number.isInteger(raw.start) && raw.start >= 0 ? raw.start : 0,
  };
  if (typeof raw.anchorKey === 'string' && raw.anchorKey !== '') segment.anchorKey = raw.anchorKey;
  if (typeof raw.nodeKind === 'string' && raw.nodeKind !== '') segment.nodeKind = raw.nodeKind;
  return segment;
}

/**
 * Normalize one persisted annotation.
 *
 * @param {unknown} raw candidate loaded from storage or a window message
 * @param {number} [now] timestamp used when the record has none
 * @returns {object | null} a valid annotation, or null when it cannot be used
 */
export function annoNormalizeAnnotation(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const stamp = annoFinite(now, annoNow());
  const source = raw.source === 'document' ? 'document' : raw.source === 'chat' ? 'chat' : null;
  if (source === null) return null;
  const segments = Array.isArray(raw.segments)
    ? raw.segments.slice(0, ANNO_MAX_SEGMENTS).map(annoNormalizeSegment).filter(Boolean)
    : [];
  if (segments.length === 0) return null;
  if (source === 'chat') {
    if (typeof raw.sessionId !== 'string' || raw.sessionId === '') return null;
    if (segments.some((segment) => !segment.anchorKey)) return null;
  } else if (typeof raw.docKey !== 'string' || raw.docKey === '') {
    return null;
  }
  const annotation = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : annoMakeId(),
    color: ANNO_COLORS.includes(raw.color) ? raw.color : 'yellow',
    note: annoClampText(raw.note, ANNO_MAX_NOTE),
    createdAt: annoFinite(raw.createdAt, stamp),
    updatedAt: annoFinite(raw.updatedAt, stamp),
    source,
    segments,
  };
  if (typeof raw.sentAt === 'number' && Number.isFinite(raw.sentAt) && raw.sentAt > 0) {
    annotation.sentAt = raw.sentAt;
  }
  if (source === 'chat') {
    annotation.sessionId = raw.sessionId;
  } else {
    annotation.docKey = raw.docKey;
    const path = annoClampText(raw.path, 2000);
    if (path !== '') annotation.path = path;
  }
  return annotation;
}

/** Fixed identity of the right-sidebar annotations tab. */
export const ANNO_TAB_ID = 'dsh-annotation';

/** Tab kind opened through the right-sidebar navigation controller. */
export const ANNO_TAB_KIND = 'annotation';

/** Creation order used for numbering and list ordering. */
function annoCreatedOrder(a, b) {
  const left = typeof a.createdAt === 'number' ? a.createdAt : 0;
  const right = typeof b.createdAt === 'number' ? b.createdAt : 0;
  if (left !== right) return left - right;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * Annotations a reader can currently reach: chat rows of the active session
 * plus every document annotation. Old chat annotations from other sessions stay
 * in storage but are not counted or listed. Numbers are assigned in creation
 * order so pins, the composer card and the sidebar list always agree.
 */
export function annoVisibleAnnotations(list, options) {
  const opts = options || {};
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : null;
  const chat = [];
  const documents = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue;
    if (item.source === 'chat') {
      if (sessionId !== null && item.sessionId === sessionId) chat.push(item);
      continue;
    }
    if (item.source === 'document') documents.push(item);
  }
  chat.sort(annoCreatedOrder);
  documents.sort(annoCreatedOrder);
  const ordered = [...chat, ...documents].sort(annoCreatedOrder);
  const numbers = new Map();
  let next = 0;
  for (const item of ordered) {
    next += 1;
    numbers.set(item.id, next);
  }
  return { chat: chat, documents: documents, numbers: numbers, count: next };
}

/** Whether an annotation already travelled to the agent and was not edited since. */
export function annoIsSent(annotation) {
  return (
    !!annotation &&
    typeof annotation.sentAt === 'number' &&
    (annotation.updatedAt || 0) <= annotation.sentAt
  );
}

/** Normalize a whole stored list, keeping order and dropping invalid rows. */
export function annoNormalizeList(rawList, now) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const raw of rawList) {
    if (out.length >= ANNO_MAX_ANNOTATIONS) break;
    const annotation = annoNormalizeAnnotation(raw, now);
    if (annotation !== null) out.push(annotation);
  }
  return out;
}

/** Read annotations from a Storage-like object. Never throws. */
export function annoReadStore(storage) {
  if (!storage || typeof storage.getItem !== 'function') return [];
  try {
    const raw = storage.getItem(ANNO_STORAGE_KEY);
    if (typeof raw !== 'string' || raw === '') return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.annotations) ? parsed.annotations : null;
    return annoNormalizeList(list);
  } catch {
    return [];
  }
}

/** Write annotations through a Storage-like object. Returns false on failure. */
export function annoWriteStore(storage, list) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    const annotations = annoNormalizeList(list);
    storage.setItem(
      ANNO_STORAGE_KEY,
      JSON.stringify({ version: ANNO_STORE_VERSION, annotations }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Insert or replace one annotation, newest first. Returns a new array. */
export function annoUpsert(list, annotation, now) {
  const normalized = annoNormalizeAnnotation(annotation, now);
  if (normalized === null) return Array.isArray(list) ? list.slice() : [];
  const base = Array.isArray(list) ? list.filter((item) => item && item.id !== normalized.id) : [];
  return [normalized, ...base].slice(0, ANNO_MAX_ANNOTATIONS);
}

/** Patch note/color/updatedAt of one annotation. Returns a new array. */
export function annoPatch(list, id, patch, now) {
  if (!Array.isArray(list)) return [];
  const stamp = annoFinite(now, annoNow());
  return list.map((item) => {
    if (!item || item.id !== id) return item;
    const next = { ...item, updatedAt: stamp };
    if (patch && ANNO_COLORS.includes(patch.color)) next.color = patch.color;
    if (patch && typeof patch.note === 'string') next.note = annoClampText(patch.note, ANNO_MAX_NOTE);
    return next;
  });
}

/** Remove one annotation. Returns a new array. */
export function annoRemove(list, id) {
  return Array.isArray(list) ? list.filter((item) => item && item.id !== id) : [];
}

/** Whether a path is absolute in a spelling the Host accepts. */
export function annoPathIsAbsolute(path) {
  return (
    typeof path === 'string' &&
    path !== '' &&
    (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path))
  );
}

/** Annotations anchored in one conversation. */
export function annoForSession(list, sessionId) {
  if (!Array.isArray(list) || typeof sessionId !== 'string') return [];
  return list.filter((item) => item && item.source === 'chat' && item.sessionId === sessionId);
}

/** Annotations of one document, matched by resource address or absolute path. */
export function annoForDocument(list, docKey, path) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => {
    if (!item || item.source !== 'document') return false;
    if (docKey && item.docKey === docKey) return true;
    return Boolean(path) && item.path === path;
  });
}

/**
 * Annotations waiting to be sent to the agent.
 *
 * A record is pending when it was never sent, or changed after the last send.
 * Chat records belong to the given conversation; document records belong to
 * one of the documents currently open in that conversation.
 */
export function annoPendingAnnotations(list, options) {
  const opts = options || {};
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : null;
  const docKeys = new Set(Array.isArray(opts.docKeys) ? opts.docKeys : []);
  const docPaths = new Set(Array.isArray(opts.docPaths) ? opts.docPaths : []);
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue;
    if (annoIsSent(item)) continue;
    if (item.source === 'chat') {
      if (sessionId !== null && item.sessionId === sessionId) out.push(item);
      continue;
    }
    const byKey = typeof item.docKey === 'string' && docKeys.has(item.docKey);
    const byPath = annoPathIsAbsolute(item.path) && docPaths.has(item.path);
    if (byKey || byPath) out.push(item);
  }
  return out;
}

/** Stamp annotations as sent at the given time. Returns a new list. */
export function annoMarkSent(list, ids, now) {
  const stamp = annoFinite(now, annoNow());
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  if (!Array.isArray(list) || wanted.size === 0) return Array.isArray(list) ? list : [];
  return list.map((item) => {
    if (!item || !wanted.has(item.id)) return item;
    return { ...item, sentAt: stamp, updatedAt: Math.max(item.updatedAt || 0, stamp) };
  });
}

/**
 * Compose the message the agent receives for a batch of annotations.
 * Quotes carry the exact selected text; document records also carry the path
 * the agent can open, so it can act on the right file.
 */
export function annoBuildAgentPrompt(list, options) {
  const opts = options || {};
  const zh = opts.zh !== false;
  const items = Array.isArray(list) ? list : [];
  const lines = [];
  lines.push(
    zh
      ? `我针对下面 ${items.length} 处具体内容做了标注，请逐条查看并处理或修改：`
      : `I annotated ${items.length} specific places below. Please review and act on each one:`,
  );
  lines.push('');
  let index = 0;
  for (const item of items) {
    index += 1;
    const quote = annoAnnotationText(item).replace(/\s+/g, ' ').trim();
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    const where =
      item.source === 'chat'
        ? zh ? '对话回复正文' : 'conversation reply'
        : '`' + (item.path || item.docKey || '?') + '`';
    if (zh) {
      lines.push(`${index}. 原文：「${quote}」`);
      lines.push(`   位置：${where}`);
      lines.push(`   批注：${note === '' ? '（无，请按原文位置处理）' : note}`);
    } else {
      lines.push(`${index}. Quote: "${quote}"`);
      lines.push(`   Location: ${where}`);
      lines.push(`   Note: ${note === '' ? '(none; act on the quoted text)' : note}`);
    }
  }
  lines.push('');
  lines.push(
    zh
      ? '请先用上面的原文定位到具体位置；文档类标注请直接修改对应文件，改完简要说明每处做了什么。'
      : 'Locate each place by the quoted text first; for document annotations edit the referenced file and briefly summarize each change.',
  );
  return lines.join('\n');
}

/** All document annotations grouped by their display path. */
export function annoGroupDocuments(list) {
  const groups = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || item.source !== 'document') continue;
    const key = item.path || item.docKey || '';
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { path: item.path, docKey: item.docKey, annotations: [item] });
    else group.annotations.push(item);
  }
  return [...groups.values()];
}

/** First-line, length-bounded quote used by list rows. */
export function annoQuotePreview(annotation, max) {
  const limit = Number.isInteger(max) && max > 0 ? max : 120;
  const first = annotation && Array.isArray(annotation.segments) && annotation.segments[0];
  const text = first && typeof first.exact === 'string' ? first.exact : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '\u2026' : flat;
}

/** Join every segment's exact text — the annotation's full quoted content. */
export function annoAnnotationText(annotation) {
  if (!annotation || !Array.isArray(annotation.segments)) return '';
  return annotation.segments.map((segment) => segment.exact).join('');
}

/**
 * Render annotations as Markdown for the clipboard.
 *
 * @param {object[]} list annotations, already filtered by the caller
 * @param {{title?: string, group?: (annotation: object) => string, noNote?: string, locale?: string}} [options]
 */
export function annoFormatMarkdown(list, options) {
  const opts = options || {};
  const lines = [];
  if (opts.title) {
    lines.push('# ' + opts.title, '');
  }
  let lastGroup = null;
  for (const annotation of Array.isArray(list) ? list : []) {
    if (!annotation) continue;
    const group = typeof opts.group === 'function' ? opts.group(annotation) : null;
    if (group && group !== lastGroup) {
      lines.push('## ' + group, '');
      lastGroup = group;
    }
    const quote = annoAnnotationText(annotation).replace(/\s+/g, ' ').trim();
    lines.push('> ' + quote);
    if (typeof annotation.note === 'string' && annotation.note.trim() !== '') {
      lines.push('', annotation.note.trim());
    } else if (opts.noNote) {
      lines.push('', '_' + opts.noNote + '_');
    }
    const when = new Date(annotation.createdAt || Date.now());
    const stamp = Number.isNaN(when.getTime()) ? '' : when.toLocaleString(opts.locale);
    if (stamp !== '') lines.push('', '<sub>' + stamp + '</sub>');
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/** Serializable export payload for the JSON download. */
export function annoExportPayload(list, meta) {
  return {
    version: ANNO_STORE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(meta && typeof meta === 'object' ? meta : {}),
    annotations: annoNormalizeList(list),
  };
}
