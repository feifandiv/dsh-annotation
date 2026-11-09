/**
 * Browser engine: selection capture, quote re-anchoring, highlight painting,
 * hit testing and navigation for annotations.
 *
 * DOM contract (verified against the shipped client bundles):
 *  - a conversation root carries data-conversation-session="<sessionId>";
 *  - each Chat row part carries data-chat-anchor-key (stable per node/part),
 *    data-chat-node-key, data-chat-flow-kind and data-chat-group-part;
 *  - a document preview root carries data-textpreview-url="<resourceAddress>",
 *    a header path label data-textpreview-path and a body data-textpreview-body.
 *
 * Painting uses the CSS Custom Highlight API, so it never mutates React-owned
 * text nodes. Every repaint re-resolves stored quotes against the current DOM.
 */

const ANNO_UI_ATTR = 'data-dsh-anno-ui';
const ANNO_HIGHLIGHT_PREFIX = 'dsh-anno-';
const ANNO_FLASH_HIGHLIGHT = 'dsh-anno-flash';
const ANNO_MAX_TEXT = 400000;
const ANNO_REPAINT_MS = 300;

const ANNO_SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'CANVAS',
  'SVG',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'BUTTON',
]);

const ANNO_IGNORE_SELECTOR = [
  '[contenteditable="true"]',
  '[data-conversation-region="composer"]',
  'textarea',
  'input',
  'select',
  '[role="textbox"]',
  '.xterm',
  'iframe',
  '[' + ANNO_UI_ATTR + ']',
].join(',');

const ANNO_DENIED_CHAT_KINDS = new Set([
  'user',
  'turn-tail',
  'tool-call',
  'command',
  'command-input',
  'context',
  'system-prompt',
  'compaction',
  'manual-compaction',
  'turn-error',
  'turn-max-tokens',
  'turn-trigger',
  'question-reply',
  'steering',
  'model-retry',
]);

/** Window storage handle, or null when the browser refuses it. */
function annoLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Opt-in compatibility flag: hide a third-party sidebar's selection button. */
const ANNO_HIDE_FOREIGN_POPUP_KEY = 'dsh.annotation.hideForeignSelectionPopup';

/** Whether the compatibility suppression was explicitly enabled. */
function annoHideForeignPopupEnabled() {
  try {
    return window.localStorage.getItem(ANNO_HIDE_FOREIGN_POPUP_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the compatibility suppression flag. */
function annoSetHideForeignPopup(enabled) {
  try {
    if (enabled === true) window.localStorage.setItem(ANNO_HIDE_FOREIGN_POPUP_KEY, '1');
    else window.localStorage.removeItem(ANNO_HIDE_FOREIGN_POPUP_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

/** Diagnostic snapshot key, written to localStorage so it is inspectable on disk. */
const ANNO_DIAG_KEY = 'dsh.annotation.diag.v1';
/** Opt-in flag: diagnostics stay off until the user enables them. */
const ANNO_DEBUG_KEY = 'dsh.annotation.debug';

/** Whether on-disk diagnostics were explicitly enabled for this browser. */
function annoReadDebugFlag() {
  try {
    return window.localStorage.getItem(ANNO_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Enable or disable on-disk diagnostics (used by the debug handle). */
function annoSetDebug(runtime, enabled) {
  if (!runtime || !runtime.diag) return;
  runtime.diag.enabled = enabled === true;
  try {
    if (enabled === true) window.localStorage.setItem(ANNO_DEBUG_KEY, '1');
    else window.localStorage.removeItem(ANNO_DEBUG_KEY);
  } catch {
    /* storage may be unavailable */
  }
  annoWriteDiag(runtime, 'debug:' + (enabled === true ? 'on' : 'off'));
}

/**
 * Persist a small diagnostic snapshot for this plugin instance.
 * This is a development aid: it lets a terminal read the live renderer state
 * (selector counts, capture reasons) without DevTools access.
 */
function annoWriteDiag(runtime, event) {
  if (!runtime.diag || runtime.diag.enabled !== true) return;
  try {
    const diag = runtime.diag;
    if (!Array.isArray(diag.events)) diag.events = [];
    diag.events.push({ type: String(event), at: Date.now() });
    if (diag.events.length > 16) diag.events.shift();
    const cs = (selector) => document.querySelectorAll(selector).length;
    const snapshot = {
      at: Date.now(),
      event: String(event),
      origin: typeof location !== 'undefined' && location ? location.origin : null,
      readyState: document.readyState,
      engineAttached: diag.engineAttached,
      styleInjected: diag.styleInjected,
      highlight: runtime.supportsHighlight,
      captureAttempts: diag.captureAttempts,
      counts: {
        sessions: cs('[data-conversation-session]'),
        conversationContents: cs('[data-conversation-content]'),
        rows: cs('[data-chat-anchor-key]'),
        assistantRows: cs('[data-chat-flow-kind="assistant-step"]'),
        docs: cs('[data-textpreview-url]'),
        docBodies: cs('[data-textpreview-body]'),
        overlayEntries: cs('[data-dsh-anno-ui]'),
        nativeTabBodies: cs('[data-sidebar-right-tab]'),
        rightbarSessions: cs('[data-sidebar-right-session]'),
        betterSidebarRoots: cs('[data-dsh-better-sidebar]'),
        cmEditors: cs('.cm-editor'),
      },
      state: {
        toolbar: runtime.state.toolbar !== null,
        editor: runtime.state.editor !== null,
        currentSessionId: runtime.state.currentSessionId,
      },
      lastPointer: diag.lastPointer,
      lastCapture: diag.lastCapture,
      lastAnchor: diag.lastAnchor || null,
      selfTest: diag.selfTest || null,
      events: diag.events,
    };
    localStorage.setItem(ANNO_DIAG_KEY, JSON.stringify(snapshot));
  } catch {
    /* diagnostics must never break the feature */
  }
}

/** Whether the CSS Custom Highlight API can paint ranges here. */
function annoSupportsHighlight() {
  return (
    typeof CSS !== 'undefined' &&
    CSS !== null &&
    typeof CSS.highlights === 'object' &&
    CSS.highlights !== null &&
    typeof Highlight === 'function' &&
    typeof Range !== 'undefined'
  );
}

/** Create the annotation store over a Storage-like backing object. */
function annoCreateStore(storage) {
  let list = annoReadStore(storage);
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a listener must not break persistence */
      }
    }
  };
  const persist = () => {
    annoWriteStore(storage, list);
  };
  return {
    list: () => list,
    find(id) {
      return list.find((item) => item.id === id) || null;
    },
    add(annotation, now) {
      list = annoUpsert(list, annotation, now);
      persist();
      emit();
      return list.find((item) => item.id === (annotation && annotation.id)) || list[0] || null;
    },
    patch(id, patch, now) {
      list = annoPatch(list, id, patch, now);
      persist();
      emit();
    },
    remove(id) {
      list = annoRemove(list, id);
      persist();
      emit();
    },
    removeMany(ids) {
      const drop = new Set(Array.isArray(ids) ? ids : []);
      if (drop.size === 0) return 0;
      const before = list.length;
      list = list.filter((item) => !drop.has(item.id));
      const removed = before - list.length;
      if (removed > 0) {
        persist();
        emit();
      }
      return removed;
    },
    markSent(ids, now) {
      list = annoMarkSent(list, ids, now);
      persist();
      emit();
    },
    reload() {
      list = annoReadStore(storage);
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** First element reached from a selection boundary node. */
function annoElementOf(node) {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node;
  if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
  return null;
}

/** Whether a boundary element already sits in an input-like or plugin-UI region. */
function annoIgnoredElement(element) {
  return element !== null && typeof element.closest === 'function' && element.closest(ANNO_IGNORE_SELECTOR) !== null;
}

/**
 * Build the visibility predicate used by every extraction in one root.
 * Uses Element.checkVisibility when present, else computed style, and caches
 * per element for the lifetime of the returned closure.
 */
function annoMakeHiddenTest() {
  const cache = new WeakMap();
  const check = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (cache.has(element)) return cache.get(element);
    let hidden = false;
    if (element.hasAttribute(ANNO_UI_ATTR)) hidden = true;
    else if (ANNO_SKIP_TAGS.has(element.tagName)) hidden = true;
    else if (element.hidden) hidden = true;
    else {
      try {
        if (typeof element.checkVisibility === 'function') {
          hidden = !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
        } else {
          const style = window.getComputedStyle(element);
          hidden = style.display === 'none' || style.visibility === 'hidden';
        }
      } catch {
        hidden = false;
      }
    }
    if (!hidden) hidden = check(element.parentElement);
    cache.set(element, hidden);
    return hidden;
  };
  return check;
}

/**
 * Collect visible text nodes of a root into one canonical string plus offsets.
 * The same function is used on capture and repaint, so offsets agree.
 */
function annoCollectTextNodes(root, hidden) {
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || hidden(parent)) continue;
    const value = node.data;
    if (!value) continue;
    const start = text.length;
    text += value;
    nodes.push({ node, start, end: text.length });
    if (text.length >= ANNO_MAX_TEXT) break;
  }
  return { text, nodes };
}

/** Absolute text offset of a selection boundary inside a pre-collected root. */
function annoOffsetInNodes(collected, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    for (const item of collected.nodes) {
      if (item.node === container) return item.start + Math.min(offset, container.data.length);
    }
    return null;
  }
  if (collected.nodes.length === 0) return 0;
  const probe = document.createRange();
  try {
    probe.setStart(container, offset);
    probe.collapse(true);
  } catch {
    return null;
  }
  for (const item of collected.nodes) {
    let relation;
    try {
      relation = probe.comparePoint(item.node, 0);
    } catch {
      relation = 1;
    }
    if (relation >= 0) return item.start;
  }
  return collected.nodes[collected.nodes.length - 1].end;
}

/** Build a DOM Range from canonical text offsets. */
function annoRangeFromOffsets(nodes, start, end) {
  if (!Array.isArray(nodes) || end <= start) return null;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;
  for (const item of nodes) {
    if (startNode === null && start < item.end) {
      startNode = item.node;
      startOffset = Math.max(0, start - item.start);
    }
    if (startNode !== null && end <= item.end) {
      endNode = item.node;
      endOffset = Math.max(0, end - item.start);
      break;
    }
  }
  if (startNode === null || endNode === null) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(startOffset, startNode.data.length));
    range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/** Clip a selection range to the inside of one root element. */
function annoClipRange(range, root) {
  const bounds = document.createRange();
  try {
    bounds.selectNodeContents(root);
  } catch {
    return null;
  }
  const clipped = range.cloneRange();
  try {
    if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
      clipped.setStart(bounds.startContainer, bounds.startOffset);
    }
    if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
      clipped.setEnd(bounds.endContainer, bounds.endOffset);
    }
  } catch {
    return null;
  }
  return clipped.collapsed ? null : clipped;
}

/** Capture one clipped selection inside one root, with an inspectable trace. */
function annoCaptureInRootDebug(range, root, extra) {
  const hidden = annoMakeHiddenTest();
  const collected = annoCollectTextNodes(root, hidden);
  const debug = {
    nodes: collected.nodes.length,
    textLength: collected.text.length,
    rootVisible: null,
    startType: range.startContainer.nodeType,
    endType: range.endContainer.nodeType,
    start: null,
    end: null,
    segment: false,
    exact: null,
  };
  try {
    debug.rootVisible =
      typeof root.checkVisibility === 'function'
        ? root.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
        : null;
  } catch {
    debug.rootVisible = 'throw';
  }
  const finish = (segment, mode) => {
    debug.mode = mode;
    debug.segment = segment !== null;
    if (segment !== null) debug.exact = segment.exact.slice(0, 40);
    return { segment, debug };
  };
  if (collected.nodes.length > 0) {
    const start = annoOffsetInNodes(collected, range.startContainer, range.startOffset);
    const end = annoOffsetInNodes(collected, range.endContainer, range.endOffset);
    debug.start = start;
    debug.end = end;
    if (start !== null && end !== null && end > start) {
      const segment = annoBuildSegment(collected.text, start, end, extra);
      if (segment !== null) return finish(segment, 'normal');
    }
  }
  // Fallback 1: re-extract including text that the visibility filter skipped.
  // An annotation on visible text must not be lost because a wrapper hides
  // decoration text from the walk.
  const loose = annoCollectTextNodes(root, () => false);
  if (loose.nodes.length > 0) {
    const start = annoOffsetInNodes(loose, range.startContainer, range.startOffset);
    const end = annoOffsetInNodes(loose, range.endContainer, range.endOffset);
    debug.looseStart = start;
    debug.looseEnd = end;
    if (start !== null && end !== null && end > start) {
      const segment = annoBuildSegment(loose.text, start, end, extra);
      if (segment !== null) return finish(segment, 'loose');
    }
  }
  // Fallback 2: the selection text itself, matched later by quote search.
  let raw = '';
  try {
    raw = range.toString();
  } catch {
    raw = '';
  }
  if (raw.trim() !== '') {
    const exact = annoClampText(raw, ANNO_MAX_QUOTE);
    const segment = { exact, prefix: '', suffix: '', start: 0 };
    if (extra && extra.anchorKey) segment.anchorKey = extra.anchorKey;
    if (extra && extra.nodeKind) segment.nodeKind = extra.nodeKind;
    return finish(segment, 'raw');
  }
  return finish(null, 'none');
}

/** Capture one clipped selection inside one root as a stored quote segment. */
function annoCaptureInRoot(range, root, extra) {
  return annoCaptureInRootDebug(range, root, extra).segment;
}

/** The last non-empty client rect of a selection, in viewport coordinates. */
function annoSelectionRect(range) {
  let rects;
  try {
    rects = Array.from(range.getClientRects());
  } catch {
    return null;
  }
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i];
    if (rect.width > 0 || rect.height > 0) {
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    }
  }
  return null;
}

/** Chat rows that may carry annotatable text. Group seats are the only structure excluded. */
function annoChatRowAllowed(row) {
  if (!row) return false;
  if (row.hasAttribute('data-chat-group-key')) return false;
  const kind = row.getAttribute('data-chat-flow-kind');
  if (kind === null) return true;
  if (kind === 'assistant-step') return true;
  if (kind === 'turn-process') return true;
  return !ANNO_DENIED_CHAT_KINDS.has(kind);
}

/** Short text sample of a range, for diagnostics only. */
function snapshotTextOf(range) {
  try {
    return range.toString().slice(0, 60);
  } catch {
    return null;
  }
}

/** Document identity carried by one preview root. */
function annoDocInfo(wrapper) {
  if (!wrapper) return null;
  const docKey = wrapper.getAttribute('data-textpreview-url') || '';
  if (docKey === '') return null;
  let path = '';
  const label = wrapper.querySelector('[data-textpreview-path]');
  if (label !== null) {
    path = (label.getAttribute('title') || label.textContent || '').trim();
  }
  return { docKey, path };
}

/** Document body that hosts annotatable text. */
function annoDocBody(wrapper) {
  if (!wrapper) return null;
  return wrapper.querySelector('[data-textpreview-body]') || wrapper;
}

/** Decode a `dsh-resource://file/…` address into a path; null for other addresses. */
function annoFileAddressPath(address) {
  if (typeof address !== 'string' || !address.startsWith('dsh-resource://file/')) return null;
  try {
    const end = address.search(/[?#]/);
    const parts = address.slice('dsh-resource://file/'.length, end === -1 ? undefined : end).split('/');
    const scope = parts.shift();
    if (scope === 'session') {
      const id = parts.shift();
      if (!id || parts.length === 0) return null;
      return parts.map(decodeURIComponent).join('/');
    }
    if (scope === 'absolute') {
      const unc = parts[0] === '' && parts.length > 1;
      const segments = (unc ? parts.slice(1) : parts).map(decodeURIComponent);
      if (segments.length === 0 || segments[0] === '') return null;
      if (unc) return '//' + segments.join('/');
      return /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : '/' + segments.join('/');
    }
    return null;
  } catch {
    return null;
  }
}

/** The host right-sidebar service, resolved lazily and cached on the runtime. */
function annoSidebarRight(runtime) {
  if (runtime.sidebarRight !== undefined) return runtime.sidebarRight;
  let service = null;
  try {
    service = runtime.ctx && typeof runtime.ctx.get === 'function' ? runtime.ctx.get('sidebarRight') : null;
  } catch {
    service = null;
  }
  runtime.sidebarRight = service || null;
  return runtime.sidebarRight;
}

/** Committed tab record (id, kind, contentId, title) for one native tab body. */
function annoTabRecord(runtime, sessionId, tabId) {
  if (typeof sessionId !== 'string' || typeof tabId !== 'string') return null;
  const service = annoSidebarRight(runtime);
  if (!service || typeof service.tabsIn !== 'function') return null;
  try {
    const records = service.tabsIn(sessionId);
    if (!Array.isArray(records)) return null;
    return records.find((record) => record && record.id === tabId) || null;
  } catch {
    return null;
  }
}

/**
 * Document identity for a host-native right-sidebar tab body.
 *
 * Third-party preview plugins (for example a replacement sidebar) render
 * their file viewers inside the host's `[data-sidebar-right-tab]` body. The
 * body carries the tab id; the host service maps that id to the resource
 * address, which is the same identity the native preview uses.
 */
function annoNativeDocInfo(runtime, body) {
  if (!body) return null;
  const sessionEl = body.closest('[data-sidebar-right-session]');
  const sessionId = sessionEl ? sessionEl.getAttribute('data-sidebar-right-session') : null;
  const tabId = body.getAttribute('data-sidebar-right-tab');
  const record = annoTabRecord(runtime, sessionId, tabId);
  if (record === null) return null;
  const contentId = typeof record.contentId === 'string' ? record.contentId : '';
  if (!contentId.startsWith('dsh-resource://file/')) return null;
  return {
    docKey: contentId,
    path: annoFileAddressPath(contentId) || undefined,
    title: typeof record.title === 'string' ? record.title : '',
    sessionId: sessionId || undefined,
    tabId: tabId || undefined,
  };
}

/** Every mounted native tab body that is a file document. */
function annoNativeDocBodies(runtime) {
  const out = [];
  for (const body of document.querySelectorAll('[data-sidebar-right-tab]')) {
    if (body.tagName !== 'DIV') continue;
    const info = annoNativeDocInfo(runtime, body);
    if (info !== null) out.push({ body, info });
  }
  return out;
}

/** The conversation service scoped to one session, or null when unavailable. */
function annoConversationFor(runtime, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const ctx = runtime.ctx;
  if (!ctx || typeof ctx.get !== 'function') return null;
  let sessions = null;
  try {
    sessions = ctx.get('sessions');
  } catch {
    sessions = null;
  }
  if (!sessions || typeof sessions.scope !== 'function') return null;
  let scoped = null;
  try {
    scoped = sessions.scope(sessionId);
  } catch {
    scoped = null;
  }
  if (!scoped) return null;
  let conversation = null;
  try {
    conversation = typeof scoped.get === 'function' ? scoped.get('conversation') : null;
  } catch {
    conversation = null;
  }
  if (!conversation) {
    try {
      conversation = scoped.conversation || null;
    } catch {
      conversation = null;
    }
  }
  return conversation && typeof conversation.send === 'function' ? conversation : null;
}

/** Whether the client locale asks for Chinese copy. */
function annoIsChineseLocale(runtime) {
  try {
    const ctx = runtime.ctx;
    const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
    const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
    const id = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
    if (typeof id === 'string' && id !== '') return id.toLowerCase().startsWith('zh');
  } catch {
    /* fall through */
  }
  try {
    return String(navigator.language || '').toLowerCase().startsWith('zh');
  } catch {
    return false;
  }
}

/** Whether one document annotation belongs to the given preview root. */
function annoDocMatches(annotation, info) {
  if (!annotation || !info) return false;
  if (annotation.docKey === info.docKey) return true;
  // A relative session path is ambiguous across workspaces; only an absolute
  // path may match a different resource address.
  return annoPathIsAbsolute(annotation.path) && annotation.path === info.path;
}

/** Describe the selection as a toolbar payload, or null when it is not annotatable. */
function annoCaptureSelectionAttempt(runtime) {
  let selection;
  try {
    selection = window.getSelection();
  } catch {
    return null;
  }
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startEl = annoElementOf(range.startContainer);
  const endEl = annoElementOf(range.endContainer);
  if (startEl === null || endEl === null) return null;
  if (annoIgnoredElement(startEl) || annoIgnoredElement(endEl)) return null;
  const rect = annoSelectionRect(range);
  if (rect === null) return null;

  const startDoc = startEl.closest('[data-textpreview-url]');
  const endDoc = endEl.closest('[data-textpreview-url]');
  if (startDoc !== null) {
    if (endDoc !== startDoc) return null;
    const payload = annoCaptureDoc(range, startDoc, rect);
    if (payload !== null) runtime.setCurrentDocument(payload.docKey, payload.path);
    return payload;
  }

  const startRow = startEl.closest('[data-chat-anchor-key]');
  if (startRow === null) {
    const nativeBody = startEl.closest('[data-sidebar-right-tab]');
    if (nativeBody !== null) {
      const payload = annoCaptureNativeDoc(runtime, range, nativeBody, rect);
      if (payload !== null) runtime.setCurrentDocument(payload.docKey, payload.path);
      return payload;
    }
    return null;
  }
  const sessionEl = startRow.closest('[data-conversation-session]');
  const sessionId = sessionEl ? sessionEl.getAttribute('data-conversation-session') : runtime.state.currentSessionId;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const scope = startEl.closest('[data-conversation-content]') || document;
  const candidates = [];
  for (const row of scope.querySelectorAll('[data-chat-anchor-key]')) {
    if (!annoChatRowAllowed(row)) continue;
    try {
      if (range.intersectsNode(row)) candidates.push(row);
    } catch {
      /* ignore detached rows */
    }
  }
  if (candidates.length === 0 && annoChatRowAllowed(startRow)) candidates.push(startRow);
  const segments = [];
  const traces = [];
  for (const row of candidates) {
    const clipped = annoClipRange(range, row);
    const trace = {
      key: row.getAttribute('data-chat-anchor-key') || null,
      kind: row.getAttribute('data-chat-flow-kind') || null,
      nested: row.querySelector('[data-chat-anchor-key]') !== null,
      clipped: clipped !== null,
      clippedCollapsed: clipped !== null ? clipped.collapsed : null,
    };
    if (clipped === null) {
      traces.push(trace);
      continue;
    }
    const result = annoCaptureInRootDebug(clipped, row, {
      anchorKey: row.getAttribute('data-chat-anchor-key') || undefined,
      nodeKind: row.getAttribute('data-chat-flow-kind') || undefined,
    });
    trace.anchor = result.debug;
    traces.push(trace);
    if (result.segment !== null && result.segment.anchorKey) segments.push(result.segment);
  }
  runtime.diag.lastAnchor = { candidates: candidates.length, selection: snapshotTextOf(range), trace: traces };
  if (segments.length === 0) return null;
  if (runtime.state.currentSessionId === null) runtime.setCurrentSession(sessionId);
  const text = segments.map((segment) => segment.exact).join('');
  return { source: 'chat', sessionId, segments, rect, text };
}

/** One-line description of the live selection, for diagnostics. */
function annoSelectionSnapshot() {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return { ok: false, reason: 'no-selection' };
    const range = selection.getRangeAt(0);
    const startEl = annoElementOf(range.startContainer);
    if (startEl === null) return { ok: false, reason: 'no-element' };
    const row = startEl.closest('[data-chat-anchor-key]');
    const doc = startEl.closest('[data-textpreview-url]');
    const conv = startEl.closest('[data-conversation-content]');
    return {
      ok: true,
      collapsed: selection.isCollapsed,
      textLength: range.toString().length,
      tag: startEl.tagName,
      inConversation: conv !== null,
      inDocument: doc !== null,
      rowKind: row !== null ? row.getAttribute('data-chat-flow-kind') : null,
      rowPart: row !== null ? row.getAttribute('data-chat-group-part') : null,
      rowAllowed: row !== null ? annoChatRowAllowed(row) : null,
      rowHasNested: row !== null ? row.querySelector('[data-chat-anchor-key]') !== null : null,
      ignored: annoIgnoredElement(startEl),
      inNativeTab: startEl.closest('[data-sidebar-right-tab]') !== null,
      nativeTab: (() => {
        const body = startEl.closest('[data-sidebar-right-tab]');
        if (body === null) return null;
        const session = body.closest('[data-sidebar-right-session]');
        return {
          tabId: body.getAttribute('data-sidebar-right-tab'),
          sessionId: session ? session.getAttribute('data-sidebar-right-session') : null,
          tag: body.tagName,
        };
      })(),
      inBetterSidebar: startEl.closest('[data-dsh-better-sidebar]') !== null,
      conversationRows: document.querySelectorAll('[data-chat-anchor-key]').length,
      assistantRows: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
    };
  } catch (error) {
    return { ok: false, reason: 'exception', error: String(error && error.message ? error.message : error) };
  }
}

/** Reason code for a selection the capture refused. */
function annoCaptureFailReason(snapshot) {
  if (!snapshot || snapshot.ok === false) return snapshot && snapshot.reason ? snapshot.reason : 'no-selection';
  if (snapshot.collapsed) return 'collapsed';
  if (snapshot.ignored) return 'ignored-region';
  if (!snapshot.inConversation && !snapshot.inDocument) return 'outside-target';
  if (snapshot.inDocument) return 'document-anchor-failed';
  if (snapshot.rowKind === null) return 'no-chat-row';
  if (!snapshot.rowAllowed) return 'chat-row-not-annotatable';
  return 'anchor-mismatch';
}

/** Capture the current selection and record why it was refused, if it was. */
function annoCaptureSelection(runtime) {
  const snapshot = annoSelectionSnapshot();
  let payload = null;
  try {
    payload = annoCaptureSelectionAttempt(runtime);
  } catch (error) {
    snapshot.error = String(error && error.message ? error.message : error);
  }
  if (payload !== null) {
    runtime.diag.lastCapture = {
      at: Date.now(),
      ok: true,
      reason: 'ok',
      textLength: snapshot.textLength,
      rowKind: snapshot.rowKind,
      inConversation: snapshot.inConversation,
      inDocument: snapshot.inDocument,
    };
  } else {
    runtime.diag.lastCapture = {
      at: Date.now(),
      ok: false,
      reason: snapshot.error ? 'exception' : annoCaptureFailReason(snapshot),
      snapshot,
    };
  }
  return payload;
}

/** Capture a selection inside a host-native right-sidebar document tab. */
function annoCaptureNativeDoc(runtime, range, body, rect) {
  const info = annoNativeDocInfo(runtime, body);
  if (info === null) return null;
  const clipped = annoClipRange(range, body);
  if (clipped === null) return null;
  const segment = annoCaptureInRoot(clipped, body, undefined);
  if (segment === null) return null;
  return {
    source: 'document',
    docKey: info.docKey,
    path: info.path,
    title: info.title,
    segments: [segment],
    rect,
    text: segment.exact,
  };
}

/** Capture a selection confined to one document preview. */
function annoCaptureDoc(range, wrapper, rect) {
  const info = annoDocInfo(wrapper);
  if (info === null) return null;
  const body = annoDocBody(wrapper);
  const clipped = annoClipRange(range, body);
  if (clipped === null) return null;
  const segment = annoCaptureInRoot(clipped, body, undefined);
  if (segment === null) return null;
  return {
    source: 'document',
    docKey: info.docKey,
    path: info.path || undefined,
    segments: [segment],
    rect,
    text: segment.exact,
  };
}

/** Paint-time counters for the diagnostic snapshot. */
const ANNO_PAINT_STATS = { loose: 0 };

/** Resolve one stored quote segment against a root element. */
function annoSegmentRange(cache, root, segment) {
  if (!root || !segment) return null;
  let collected = cache.get(root);
  if (collected === undefined) {
    collected = annoCollectTextNodes(root, annoMakeHiddenTest());
    cache.set(root, collected);
  }
  const resolved = annoResolveSegment(collected.text, segment);
  if (resolved !== null) {
    const range = annoRangeFromOffsets(collected.nodes, resolved.start, resolved.end);
    if (range !== null) return range;
  }
  // The visibility filter can hide decoration text between the annotated words;
  // retry over the unfiltered text so a visible annotation still paints.
  let looseCache = cache.get('__annoLoose');
  if (looseCache === undefined) {
    looseCache = new Map();
    cache.set('__annoLoose', looseCache);
  }
  let loose = looseCache.get(root);
  if (loose === undefined) {
    loose = annoCollectTextNodes(root, () => false);
    looseCache.set(root, loose);
  }
  const looseResolved = annoResolveSegment(loose.text, segment);
  if (looseResolved === null) return null;
  const looseRange = annoRangeFromOffsets(loose.nodes, looseResolved.start, looseResolved.end);
  if (looseRange !== null) ANNO_PAINT_STATS.loose += 1;
  return looseRange;
}

/** Compute the live ranges of one annotation, plus the open documents it hit. */
function annoComputeRanges(runtime, annotation, cache, rowIndex, wrappers, nativeDocs) {
  const ranges = [];
  if (annotation.source === 'chat') {
    for (const segment of annotation.segments) {
      const rows = rowIndex.get(segment.anchorKey) || [];
      for (const row of rows) {
        const sessionEl = row.closest('[data-conversation-session]');
        const sessionId = sessionEl ? sessionEl.getAttribute('data-conversation-session') : null;
        if (sessionId !== null && sessionId !== annotation.sessionId) continue;
        const range = annoSegmentRange(cache, row, segment);
        if (range !== null) ranges.push(range);
      }
    }
    return ranges;
  }
  for (const wrapper of wrappers) {
    const info = annoDocInfo(wrapper);
    if (!annoDocMatches(annotation, info)) continue;
    const body = annoDocBody(wrapper);
    for (const segment of annotation.segments) {
      const range = annoSegmentRange(cache, body, segment);
      if (range !== null) ranges.push(range);
    }
  }
  for (const entry of nativeDocs || []) {
    if (!annoDocMatches(annotation, entry.info)) continue;
    for (const segment of annotation.segments) {
      const range = annoSegmentRange(cache, entry.body, segment);
      if (range !== null) ranges.push(range);
    }
  }
  return ranges;
}

/** Re-resolve and paint every annotation currently present in the DOM. */
function annoPaint(runtime) {
  const cache = new Map();
  const rowIndex = new Map();
  for (const row of document.querySelectorAll('[data-chat-anchor-key]')) {
    const key = row.getAttribute('data-chat-anchor-key');
    if (!key) continue;
    const rows = rowIndex.get(key);
    if (rows === undefined) rowIndex.set(key, [row]);
    else rows.push(row);
  }
  const wrappers = Array.from(document.querySelectorAll('[data-textpreview-url]'));
  const nativeDocs = annoNativeDocBodies(runtime);
  const byColor = new Map();
  for (const color of ANNO_COLORS) byColor.set(color, []);
  const rangesById = new Map();
  const unresolved = [];
  ANNO_PAINT_STATS.loose = 0;
  const openDocs = [];
  for (const wrapper of wrappers) {
    const info = annoDocInfo(wrapper);
    if (info !== null && bodyVisible(wrapper) && !openDocs.some((entry) => entry.docKey === info.docKey)) openDocs.push(info);
  }
  for (const entry of nativeDocs) {
    const info = entry.info;
    if (bodyVisible(entry.body) && !openDocs.some((open) => open.docKey === info.docKey)) openDocs.push(info);
  }
  for (const annotation of runtime.store.list()) {
    const ranges = annoComputeRanges(runtime, annotation, cache, rowIndex, wrappers, nativeDocs);
    if (ranges.length === 0) {
      unresolved.push({ id: annotation.id, source: annotation.source, color: annotation.color });
      continue;
    }
    rangesById.set(annotation.id, ranges);
    const bucket = byColor.get(annotation.color);
    if (bucket !== undefined) bucket.push(...ranges);
  }
  runtime.paintedRanges = rangesById;
  runtime.diag.paint = {
    at: Date.now(),
    total: runtime.store.list().length,
    painted: rangesById.size,
    loose: ANNO_PAINT_STATS.loose,
    unresolved: unresolved.slice(0, 8),
  };
  runtime.setOpenDocuments(openDocs);
  annoUpdatePins(runtime);
  if (!annoSupportsHighlight()) return;
  for (const color of ANNO_COLORS) {
    const name = ANNO_HIGHLIGHT_PREFIX + color;
    const bucket = byColor.get(color) || [];
    if (bucket.length === 0) {
      CSS.highlights.delete(name);
      continue;
    }
    try {
      CSS.highlights.set(name, new Highlight(...bucket.slice(0, 2000)));
    } catch {
      CSS.highlights.delete(name);
    }
  }
}

/** Recompute the inline annotation pins from the painted ranges. */
function annoUpdatePins(runtime) {
  if (!runtime || document.visibilityState === 'hidden') return;
  if (!runtime.paintedRanges) return;
  const next = [];
  const numbers = annoVisibleAnnotations(runtime.store.list(), {
    sessionId: runtime.state.currentSessionId,
  }).numbers;
  for (const annotation of runtime.store.list()) {
    const ranges = runtime.paintedRanges.get(annotation.id);
    if (!ranges || ranges.length === 0) continue;
    let rect = null;
    try {
      rect = ranges[0].getBoundingClientRect();
    } catch {
      rect = null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;
    const sent = typeof annotation.sentAt === 'number' && (annotation.updatedAt || 0) <= annotation.sentAt;
    next.push({
      id: annotation.id,
      color: annotation.color,
      number: numbers.get(annotation.id) || 0,
      left: Math.min(rect.right + 8, (window.innerWidth || 1024) - 26),
      top: rect.top + rect.height / 2,
      sent,
      note: typeof annotation.note === 'string' ? annotation.note : '',
      quote: annoQuotePreview(annotation, 90),
    });
  }
  const previous = runtime.state.pins || [];
  const same =
    previous.length === next.length &&
    previous.every(
      (pin, i) =>
        pin.id === next[i].id &&
        Math.abs(pin.left - next[i].left) < 1 &&
        Math.abs(pin.top - next[i].top) < 1 &&
        pin.sent === next[i].sent,
    );
  if (!same) {
    runtime.state.pins = next;
    runtime.notify();
  }
}

/** Whether a preview wrapper is laid out (visible background panes still count). */
function bodyVisible(wrapper) {
  try {
    return wrapper.getClientRects().length > 0;
  } catch {
    return true;
  }
}

/** Find the innermost annotation range containing a viewport point. */
function annoHitTest(runtime, x, y) {
  const painted = runtime.paintedRanges;
  if (!painted || painted.size === 0) return null;
  let caret = null;
  if (typeof document.caretRangeFromPoint === 'function') {
    caret = document.caretRangeFromPoint(x, y);
  } else if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y);
    if (position) {
      caret = document.createRange();
      try {
        caret.setStart(position.offsetNode, position.offset);
        caret.collapse(true);
      } catch {
        caret = null;
      }
    }
  }
  if (caret === null) return null;
  const container = caret.startContainer;
  const offset = caret.startOffset;
  for (const [id, ranges] of painted) {
    for (const range of ranges) {
      let inside = false;
      try {
        inside = range.comparePoint(container, offset) === 0;
      } catch {
        inside = false;
      }
      if (inside) return runtime.store.find(id) || { id };
    }
  }
  return null;
}

/** Paint a short-lived stronger highlight over one annotation's ranges. */
function annoFlashRanges(ranges) {
  if (!annoSupportsHighlight() || !Array.isArray(ranges) || ranges.length === 0) return;
  try {
    CSS.highlights.set(ANNO_FLASH_HIGHLIGHT, new Highlight(...ranges.slice(0, 50)));
  } catch {
    return;
  }
  if (annoFlashRanges.timer) window.clearTimeout(annoFlashRanges.timer);
  annoFlashRanges.timer = window.setTimeout(() => {
    try {
      CSS.highlights.delete(ANNO_FLASH_HIGHLIGHT);
    } catch {
      /* already gone */
    }
  }, 1600);
}

/** Scroll to and flash one annotation. Returns false when it is not in the DOM. */
function annoReveal(runtime, annotation) {
  const painted = runtime.paintedRanges && runtime.paintedRanges.get(annotation.id);
  let ranges = painted || null;
  if (!ranges) {
    const cache = new Map();
    const rowIndex = new Map();
    for (const row of document.querySelectorAll('[data-chat-anchor-key]')) {
      const key = row.getAttribute('data-chat-anchor-key');
      if (!key) continue;
      const rows = rowIndex.get(key);
      if (rows === undefined) rowIndex.set(key, [row]);
      else rows.push(row);
    }
    ranges = annoComputeRanges(
      runtime,
      annotation,
      cache,
      rowIndex,
      Array.from(document.querySelectorAll('[data-textpreview-url]')),
      annoNativeDocBodies(runtime),
    );
  }
  if (!ranges || ranges.length === 0) return false;
  const first = ranges[0];
  const element = annoElementOf(first.startContainer);
  if (element !== null) {
    try {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch {
      /* older browsers ignore the options bag */
    }
  }
  annoFlashRanges(ranges);
  return true;
}

/** Copy plain text through the clipboard API, falling back to a hidden textarea. */
async function annoCopyPlain(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Create the runtime shared by the overlay UI, the engine and the plugin body. */
function annoCreateRuntime(ctx) {
  const runtime = {
    ctx: ctx || null,
    sidebarRight: undefined,
    store: annoCreateStore(annoLocalStorage()),
    state: {
      version: 0,
      toolbar: null,
      editor: null,
      currentSessionId: null,
      currentDocKey: null,
      currentDocPath: null,
      openDocs: [],
      notice: null,
      pins: [],
    },
    paintedRanges: new Map(),
    pruneSize: 0,
    tabRegistered: false,
    tabDispose: null,
    diag: {
      enabled: annoReadDebugFlag(),
      engineAttached: false,
      styleInjected: false,
      captureAttempts: 0,
      lastCapture: null,
      lastPointer: null,
    },
    listeners: new Set(),
    repaintTimer: 0,
    supportsHighlight: annoSupportsHighlight(),
    notify() {
      runtime.state.version += 1;
      for (const fn of [...runtime.listeners]) {
        try {
          fn();
        } catch {
          /* a subscriber must not break others */
        }
      }
    },
    subscribe(fn) {
      runtime.listeners.add(fn);
      return () => {
        runtime.listeners.delete(fn);
      };
    },
    setToolbar(toolbar) {
      if (runtime.state.toolbar === toolbar) return;
      runtime.state.toolbar = toolbar;
      runtime.notify();
    },
    setEditor(editor) {
      runtime.state.editor = editor;
      runtime.notify();
    },
    setCurrentSession(sessionId) {
      if (sessionId === runtime.state.currentSessionId) return;
      runtime.state.currentSessionId = sessionId;
      runtime.notify();
    },
    setCurrentDocument(docKey, path) {
      if (docKey === runtime.state.currentDocKey && path === runtime.state.currentDocPath) return;
      runtime.state.currentDocKey = docKey;
      runtime.state.currentDocPath = path || null;
    },
    setOpenDocuments(list) {
      const before = runtime.state.openDocs;
      const same =
        before.length === list.length &&
        before.every((entry, index) => entry.docKey === list[index].docKey && entry.path === list[index].path);
      if (same) return;
      runtime.state.openDocs = list;
      runtime.notify();
    },
    pendingAnnotations() {
      const docs = runtime.state.openDocs || [];
      return annoPendingAnnotations(runtime.store.list(), {
        sessionId: runtime.state.currentSessionId,
        docKeys: docs.map((entry) => entry.docKey),
        docPaths: docs.map((entry) => entry.path).filter(Boolean),
      });
    },
    sendPendingAnnotations() {
      const pending = runtime.pendingAnnotations();
      if (pending.length === 0) {
        runtime.setNotice('none');
        return false;
      }
      const zh = annoIsChineseLocale(runtime);
      const text = annoBuildAgentPrompt(pending, { zh: zh });
      const ids = pending.map((item) => item.id);
      runtime.setEditor(null);
      runtime.setToolbar(null);
      const conversation = annoConversationFor(runtime, runtime.state.currentSessionId);
      if (conversation === null) {
        runtime.setNotice('unavailable');
        return false;
      }
      runtime.setNotice('sending');
      Promise.resolve()
        .then(() => conversation.send(text))
        .then(() => {
          runtime.store.markSent(ids);
          runtime.repaint();
          runtime.setNotice('sent');
          runtime.scheduleDocumentCleanup(ids);
        })
        .catch(() => runtime.setNotice('failed'));
      return true;
    },
    schedulePins() {
      if (runtime.pinsTimer) return;
      runtime.pinsTimer = window.setTimeout(() => {
        runtime.pinsTimer = 0;
        annoUpdatePins(runtime);
      }, 90);
    },
    setNotice(text) {
      runtime.state.notice = text;
      runtime.notify();
      if (runtime.noticeTimer) window.clearTimeout(runtime.noticeTimer);
      runtime.noticeTimer = window.setTimeout(() => {
        if (runtime.state.notice === text) {
          runtime.state.notice = null;
          runtime.notify();
        }
      }, 2600);
    },
    repaint() {
      if (document.visibilityState === 'hidden') return;
      try {
        annoPaint(runtime);
      } catch {
        /* painting must never break the host UI */
      }
      if (runtime.store.list().length > 0 && Date.now() - (runtime.diag.lastPaintWrite || 0) > 1500) {
        runtime.diag.lastPaintWrite = Date.now();
        annoWriteDiag(runtime, 'paint');
      }
    },
    scheduleRepaint() {
      if (runtime.repaintTimer) return;
      runtime.repaintTimer = window.setTimeout(() => {
        runtime.repaintTimer = 0;
        runtime.repaint();
      }, ANNO_REPAINT_MS);
    },
    openEditor(id, anchor) {
      runtime.state.toolbar = null;
      runtime.state.editor = { id, anchor: anchor || null };
      runtime.notify();
    },
    commitAnnotation(note) {
      const payload = runtime.state.toolbar;
      if (!payload) return null;
      const annotation = {
        id: annoMakeId(),
        // One highlight color: the comments themselves carry the emphasis.
        color: ANNO_COLORS[0],
        note: typeof note === 'string' ? note : '',
        createdAt: annoNow(),
        updatedAt: annoNow(),
        source: payload.source,
        segments: payload.segments.map((segment) => ({ ...segment })),
      };
      if (payload.source === 'chat') annotation.sessionId = payload.sessionId;
      else {
        annotation.docKey = payload.docKey;
        if (payload.path) annotation.path = payload.path;
      }
      const normalized = annoNormalizeAnnotation(annotation);
      if (normalized === null) return null;
      runtime.store.add(normalized);
      runtime.setToolbar(null);
      runtime.repaint();
      try {
        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      } catch {
        /* ignore */
      }
      return normalized;
    },
    copySelected() {
      const payload = runtime.state.toolbar;
      if (!payload) return false;
      annoCopyPlain(payload.text || '');
      runtime.setToolbar(null);
      return true;
    },
    patchNote(id, note) {
      runtime.store.patch(id, { note });
      runtime.schedulePins();
    },
    removeAnnotation(id) {
      runtime.store.remove(id);
      if (runtime.state.editor && runtime.state.editor.id === id) runtime.setEditor(null);
      runtime.repaint();
    },
    reveal(annotation) {
      const found = annoReveal(runtime, annotation);
      if (!found) runtime.setNotice('missing');
      return found;
    },
    async openDocument(docKey) {
      if (typeof docKey !== 'string' || docKey === '') return false;
      let sidebarRight = null;
      try {
        sidebarRight = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null;
      } catch {
        sidebarRight = null;
      }
      if (!sidebarRight || typeof sidebarRight.openResource !== 'function') return false;
      try {
        sidebarRight.openResource(docKey);
        return true;
      } catch {
        return false;
      }
    },
    /** Session ids the client currently knows, or null while the index is not ready. */
    knownSessionIds() {
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
        const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
          ? sessions.list.getSnapshot()
          : null;
        if (!snapshot) return null;
        const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId || {});
        if (ids.length === 0) return null;
        return new Set(ids);
      } catch {
        return null;
      }
    },
    /** Drop chat annotations whose session no longer exists (deleted, not archived). */
    pruneDeletedSessions() {
      const known = runtime.knownSessionIds();
      if (known === null) return 0;
      // Automatic passes wait for a stable session index so a partially loaded
      // sidebar cannot look like a mass deletion.
      const size = known.size;
      const last = runtime.pruneSize;
      runtime.pruneSize = size;
      if (last !== size) return 0;
      const current = runtime.state.currentSessionId;
      const ids = runtime.store.list()
        .filter(
          (item) =>
            item.source === 'chat' &&
            typeof item.sessionId === 'string' &&
            item.sessionId !== current &&
            !known.has(item.sessionId),
        )
        .map((item) => item.id);
      return runtime.store.removeMany(ids);
    },
    /** Counts for the sidebar cleanup menu. */
    cleanupCounts() {
      const list = runtime.store.list();
      const current = runtime.state.currentSessionId;
      return {
        sent: list.filter((item) => annoIsSent(item)).length,
        others: list.filter((item) => item.source === 'chat' && item.sessionId !== current).length,
        total: list.length,
      };
    },
    /** Explicit cleanup actions from the sidebar list. */
    cleanupAnnotations(kind) {
      const list = runtime.store.list();
      const current = runtime.state.currentSessionId;
      let targets;
      if (kind === 'sent') targets = list.filter((item) => annoIsSent(item));
      else if (kind === 'others') targets = list.filter((item) => item.source === 'chat' && item.sessionId !== current);
      else targets = [];
      const removed = runtime.store.removeMany(targets.map((item) => item.id));
      if (removed > 0) runtime.setNotice('cleaned');
      return removed;
    },
    /** Register the right-sidebar annotation tab type; safe to retry. */
    registerAnnotationsTab() {
      if (runtime.tabRegistered) return true;
      let tabs = null;
      try {
        tabs = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : null;
      } catch {
        tabs = null;
      }
      if (!tabs || typeof tabs.register !== 'function') return false;
      try {
        const dispose = tabs.register({
          id: ANNO_TAB_ID,
          kind: ANNO_TAB_KIND,
          priority: 'extension',
          title: () => (annoIsChineseLocale(runtime) ? '标注' : 'Annotations'),
        });
        runtime.tabDispose = typeof dispose === 'function' ? dispose : null;
        runtime.tabRegistered = true;
        return true;
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        if (message.includes('already registered')) {
          runtime.tabRegistered = true;
          return true;
        }
        console.warn('[annotation] sidebar tab type registration failed', error);
        return false;
      }
    },
    /** Sent document annotations are transient: drop them after the send settles. */
    scheduleDocumentCleanup(ids) {
      const list = Array.isArray(ids) ? ids : [];
      const docIds = list.filter((id) => {
        const annotation = runtime.store.find(id);
        return annotation !== null && annotation.source === 'document';
      });
      if (docIds.length === 0) return;
      window.setTimeout(() => {
        runtime.store.removeMany(docIds);
        runtime.repaint();
      }, 1200);
    },
    /** Remove sent document annotations left over from earlier rounds. */
    cleanupSentDocuments() {
      const ids = runtime.store.list()
        .filter((item) => item.source === 'document' && annoIsSent(item))
        .map((item) => item.id);
      return runtime.store.removeMany(ids);
    },
    /** Open (or focus) the annotation list as a native right-sidebar tab. */
    openAnnotationsTab() {
      runtime.pruneDeletedSessions();
      runtime.registerAnnotationsTab();
      let sidebarRight = null;
      try {
        sidebarRight = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null;
      } catch {
        sidebarRight = null;
      }
      if (!sidebarRight || typeof sidebarRight.openTab !== 'function') return false;
      try {
        sidebarRight.openTab(ANNO_TAB_KIND);
        return true;
      } catch {
        // A hot reload can leave the registry empty even though the body slot
        // survived; retry registration once before reporting failure.
        runtime.tabRegistered = false;
        if (runtime.registerAnnotationsTab()) {
          try {
            sidebarRight.openTab(ANNO_TAB_KIND);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
    },
    dispose() {
      if (typeof runtime.tabDispose === 'function') {
        try {
          runtime.tabDispose();
        } catch {
          /* ignore */
        }
      }
      runtime.tabDispose = null;
      runtime.tabRegistered = false;
      if (runtime.repaintTimer) window.clearTimeout(runtime.repaintTimer);
      runtime.repaintTimer = 0;
      if (runtime.noticeTimer) window.clearTimeout(runtime.noticeTimer);
      if (runtime.pinsTimer) window.clearTimeout(runtime.pinsTimer);
      runtime.pinsTimer = 0;
      runtime.listeners.clear();
      runtime.paintedRanges = new Map();
      if (annoSupportsHighlight()) {
        for (const color of ANNO_COLORS) {
          try {
            CSS.highlights.delete(ANNO_HIGHLIGHT_PREFIX + color);
          } catch {
            /* ignore */
          }
        }
        try {
          CSS.highlights.delete(ANNO_FLASH_HIGHLIGHT);
        } catch {
          /* ignore */
        }
      }
    },
  };
  runtime.store.subscribe(() => {
    runtime.notify();
    runtime.scheduleRepaint();
  });
  return runtime;
}

/**
 * Automatic anchor self-test: pick a visible assistant row, build a range over
 * its first non-space characters and run the same anchor extraction users hit.
 * The trace lands in the diagnostic snapshot, so a terminal can read why
 * selection capture fails without DevTools.
 */
function annoRunSelfTest(runtime) {
  try {
    const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).filter(
      (row) => {
        try {
          return row.getClientRects().length > 0;
        } catch {
          return false;
        }
      },
    );
    const report = {
      at: Date.now(),
      visibleAssistantRows: rows.length,
      found: false,
      segment: false,
      samples: [],
      byPart: {},
      firstVisibleSample: null,
      firstTextSample: null,
      rowKinds: {},
    };
    for (const row of document.querySelectorAll('[data-chat-flow-kind]')) {
      const kind = row.getAttribute('data-chat-flow-kind') || '(none)';
      report.rowKinds[kind] = (report.rowKinds[kind] || 0) + 1;
    }
    for (const candidate of rows) {
      const part = candidate.getAttribute('data-chat-group-part') || 'response';
      const bucket = report.byPart[part] || (report.byPart[part] = { rows: 0, visibleText: 0, visible: 0, texts: 0 });
      bucket.rows += 1;
      const hidden = annoMakeHiddenTest();
      const nodes = annoCollectTextNodes(candidate, hidden);
      const looseText = annoCollectTextNodes(candidate, () => false).text;
      let visible = null;
      try {
        visible = typeof candidate.checkVisibility === 'function'
          ? candidate.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
          : 'no-api';
      } catch {
        visible = 'throw';
      }
      if (nodes.text.trim().length > 20) bucket.visibleText += 1;
      if (visible === true) bucket.visible += 1;
      if (looseText.trim().length > 20) bucket.texts += 1;
      if (part === 'response' && report.firstVisibleSample === null && visible === true) {
        report.firstVisibleSample = {
          key: (candidate.getAttribute('data-chat-anchor-key') || '').slice(0, 40),
          rowText: (candidate.textContent || '').slice(0, 120),
          visibleTextLength: nodes.text.length,
          looseTextLength: looseText.length,
          visible: visible,
        };
      }
      if (report.firstTextSample === null && looseText.trim().length > 20) {
        report.firstTextSample = {
          key: (candidate.getAttribute('data-chat-anchor-key') || '').slice(0, 40),
          part: part,
          visible: visible,
          visibleTextLength: nodes.text.length,
          looseTextLength: looseText.length,
          text: looseText.slice(0, 80),
        };
      }
    }
    let row = null;
    let collected = null;
    for (const candidate of rows) {
      const hidden = annoMakeHiddenTest();
      const nodes = annoCollectTextNodes(candidate, hidden);
      if (report.samples.length < 3) {
        const safeVisibility = (element) => {
          try {
            return typeof element.checkVisibility === 'function'
              ? element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
              : 'no-api';
          } catch (error) {
            return 'throw:' + String(error && error.message ? error.message : error);
          }
        };
        const firstElement = candidate.firstElementChild;
        const style = (element) => {
          try {
            const cs = window.getComputedStyle(element);
            return { display: cs.display, visibility: cs.visibility, contentVisibility: cs.contentVisibility };
          } catch {
            return 'throw';
          }
        };
        report.samples.push({
          key: (candidate.getAttribute('data-chat-anchor-key') || '').slice(0, 30),
          kind: candidate.getAttribute('data-chat-flow-kind'),
          part: candidate.getAttribute('data-chat-group-part'),
          rowTextLength: (candidate.textContent || '').length,
          rowVisible: safeVisibility(candidate),
          rowStyle: style(candidate),
          firstTag: firstElement ? firstElement.tagName : null,
          firstVisible: firstElement ? safeVisibility(firstElement) : null,
          firstStyle: firstElement ? style(firstElement) : null,
          visibleNodes: nodes.nodes.length,
          visibleTextLength: nodes.text.length,
          looseTextLength: annoCollectTextNodes(candidate, () => false).text.length,
        });
      }
      if (nodes.text.trim().length > 20) {
        row = candidate;
        collected = nodes;
        break;
      }
    }
    if (row !== null && collected !== null) {
      report.found = true;
      let start = 0;
      while (start < collected.text.length && /\s/.test(collected.text[start])) start += 1;
      const end = Math.min(collected.text.length, start + 20);
      report.sample = collected.text.slice(start, end);
      report.nodes = collected.nodes.length;
      const range = annoRangeFromOffsets(collected.nodes, start, end);
      report.range = range !== null;
      if (range !== null) {
        const result = annoCaptureInRootDebug(range, row, {
          anchorKey: row.getAttribute('data-chat-anchor-key'),
          nodeKind: row.getAttribute('data-chat-flow-kind') || undefined,
        });
        report.segment = result.segment !== null;
        report.anchor = result.debug;
      }
      report.rowVisible = typeof row.checkVisibility === 'function'
        ? row.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })
        : null;
    }
    // Exercise the real capture path (including fallbacks) on the first row that
    // contains any text at all, so the fallback is proven without user input.
    report.fallbackTest = null;
    for (const candidate of rows) {
      const loose = annoCollectTextNodes(candidate, () => false);
      if (loose.text.trim().length <= 20) continue;
      let start = 0;
      while (start < loose.text.length && /\s/.test(loose.text[start])) start += 1;
      const range = annoRangeFromOffsets(loose.nodes, start, Math.min(loose.text.length, start + 20));
      if (range === null) continue;
      const result = annoCaptureInRootDebug(range, candidate, {
        anchorKey: candidate.getAttribute('data-chat-anchor-key'),
        nodeKind: candidate.getAttribute('data-chat-flow-kind') || undefined,
      });
      report.fallbackTest = {
        rowKey: (candidate.getAttribute('data-chat-anchor-key') || '').slice(0, 40),
        part: candidate.getAttribute('data-chat-group-part') || 'response',
        segment: result.segment !== null,
        anchor: result.debug,
      };
      break;
    }
    runtime.diag.selfTest = report;
    annoWriteDiag(runtime, 'self-test');
  } catch (error) {
    runtime.diag.selfTest = { error: String(error && error.message ? error.message : error) };
    annoWriteDiag(runtime, 'self-test-error');
  }
}

/** Attach selection, pointer, keyboard, scroll and mutation listeners. */
function annoAttachEngine(runtime) {
  const ownerDocument = document;
  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  let pointerDown = false;
  let lastPointerUpAt = 0;
  let selectionTimer = 0;

  const isUiTarget = (target) => target instanceof Element && target.closest('[' + ANNO_UI_ATTR + ']') !== null;
  const hideFloating = () => {
    if (runtime.state.toolbar !== null) runtime.setToolbar(null);
  };

  const runCapture = (source, x, y, allowHitTest) => {
    runtime.diag.captureAttempts += 1;
    const payload = annoCaptureSelection(runtime);
    annoWriteDiag(runtime, 'capture:' + source + ':' + (payload !== null ? 'ok' : 'null'));
    if (payload !== null) {
      runtime.setToolbar(payload);
      return true;
    }
    if (!allowHitTest) return false;
    let selection = null;
    try {
      selection = window.getSelection();
    } catch {
      selection = null;
    }
    if (selection && selection.isCollapsed && typeof x === 'number') {
      const hit = annoHitTest(runtime, x, y);
      if (hit !== null) {
        runtime.openEditor(hit.id, { x, y });
        return true;
      }
    }
    runtime.setToolbar(null);
    return false;
  };

  const notePointer = (event) => {
    runtime.diag.lastPointer = { type: event.type, at: Date.now(), x: event.clientX, y: event.clientY };
  };

  const onPointerDown = (event) => {
    pointerDown = true;
    notePointer(event);
    annoWriteDiag(runtime, 'pointerdown:' + event.type);
    if (isUiTarget(event.target)) return;
    hideFloating();
    if (runtime.state.editor !== null) runtime.setEditor(null);
  };

  const settleAfterRelease = (event, source) => {
    pointerDown = false;
    notePointer(event);
    annoWriteDiag(runtime, 'release:' + source);
    if (isUiTarget(event.target)) return;
    const x = event.clientX;
    const y = event.clientY;
    window.setTimeout(() => {
      runCapture(source, x, y, true);
    }, 0);
  };

  const onPointerUp = (event) => {
    lastPointerUpAt = Date.now();
    settleAfterRelease(event, 'pointerup');
  };

  const onMouseUp = (event) => {
    if (Date.now() - lastPointerUpAt < 400) return;
    settleAfterRelease(event, 'mouseup');
  };

  const onKeyUp = (event) => {
    if (event.key === 'Escape') return;
    const isSelectionKey = event.shiftKey || (event.key === 'a' && (event.metaKey || event.ctrlKey));
    if (!isSelectionKey) return;
    window.setTimeout(() => {
      runCapture('keyup', null, null, false);
    }, 0);
  };

  const onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-dsh-anno-ui], input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (runtime.state.editor !== null) return;
      if (runtime.pendingAnnotations().length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      runtime.sendPendingAnnotations();
      return;
    }
    if (event.key !== 'Escape') return;
    if (runtime.state.toolbar !== null) {
      runtime.setToolbar(null);
      return;
    }
    if (runtime.state.editor !== null) {
      runtime.setEditor(null);
      return;
    }
  };

  const onSelectionChange = () => {
    let selection = null;
    try {
      selection = window.getSelection();
    } catch {
      selection = null;
    }
    if (selection === null) return;
    if (selection.isCollapsed) {
      // The inline composer focuses its input, which collapses the document
      // selection on purpose; that collapse must not dismiss the composer.
      // A real click outside is handled by the pointerdown path instead.
      if (runtime.state.toolbar !== null) return;
      hideFloating();
      return;
    }
    if (pointerDown) return;
    // Safety net: a settled selection that produced no toolbar because the
    // release event never reached this plugin retries once after the drag ends.
    if (selectionTimer) window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      selectionTimer = 0;
      if (runtime.state.toolbar !== null) return;
      runCapture('selectionchange', null, null, false);
    }, 450);
  };

  // Scrolling (streaming output, user wheel) must not dismiss a comment box
  // the reader is typing into; only repaint the pins.
  const onScroll = () => {
    runtime.schedulePins();
  };
  const onResize = () => {
    runtime.schedulePins();
  };

  // Window capture runs before any element handler, so an application handler
  // that stops propagation cannot hide a selection release from the plugin.
  listen(window, 'pointerdown', onPointerDown, true);
  listen(window, 'pointerup', onPointerUp, true);
  listen(window, 'mousedown', onPointerDown, true);
  listen(window, 'mouseup', onMouseUp, true);
  listen(window, 'keydown', onKeyDown, true);
  listen(window, 'keyup', onKeyUp, true);
  listen(ownerDocument, 'selectionchange', onSelectionChange, false);
  listen(window, 'scroll', onScroll, true);
  listen(window, 'resize', onResize, false);

  let observer = null;
  try {
    observer = new MutationObserver(() => {
      runtime.scheduleRepaint();
    });
    observer.observe(ownerDocument.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'data-textpreview-url', 'data-chat-anchor-key', 'data-document-preview'],
    });
  } catch {
    observer = null;
  }
  if (observer !== null) cleanups.push(() => observer.disconnect());

  runtime.diag.engineAttached = true;
  annoWriteDiag(runtime, 'engine-attached');
  runtime.repaint();
  const selfTestTimers = runtime.diag.enabled
    ? [
        window.setTimeout(() => annoRunSelfTest(runtime), 1200),
        window.setTimeout(() => annoRunSelfTest(runtime), 3600),
        window.setTimeout(() => annoRunSelfTest(runtime), 8000),
      ]
    : [];
  cleanups.push(() => {
    for (const timer of selfTestTimers) window.clearTimeout(timer);
  });

  return () => {
    runtime.diag.engineAttached = false;
    annoWriteDiag(runtime, 'engine-dispose');
    if (selectionTimer) {
      window.clearTimeout(selectionTimer);
      selectionTimer = 0;
    }
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  };
}
