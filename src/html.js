/**
 * Annotatable HTML document renderer.
 *
 * The shipped HTML preview runs the page in an opaque-origin iframe
 * (`sandbox="allow-scripts"`, no `allow-same-origin`), so the parent page cannot
 * read its selection or paint its ranges. This renderer registers an external
 * document implementation for `.html`/`.htm` (which outranks the builtin one) and
 * runs its own copy of the page in the same kind of sandbox, but with a small
 * bridge script inside. The bridge owns everything that needs the frame's own
 * DOM: quote extraction, re-anchoring, CSS Custom Highlight painting, pins and
 * hit testing. It talks to the plugin runtime in the parent over `postMessage`,
 * so the persisted annotation model and the composer stay exactly where they are.
 *
 * Isolation is preserved: the iframe keeps an opaque origin and script
 * permission only. The parent never touches the frame document.
 */

/** Message namespace for the parent/frame bridge. */
const ANNO_HTML_NS = 'dsh-annotation-html';

/** Document implementation identity, also the keyed body slot key. */
const ANNO_HTML_BODY_ID = '@fanfan4589/dsh-annotation/html';

/** File suffixes this renderer claims. */
const ANNO_HTML_EXTENSIONS = ['html', 'htm'];

/** Attribute every annotation-owned node carries, so text extraction skips it. */
const ANNO_HTML_UI_ATTR = 'data-dsh-anno-ui';

/** Asset packing limits mirror the shipped implementer's budgets. */
const ANNO_HTML_MAX_ASSET_BYTES = 4 * 1024 * 1024;
const ANNO_HTML_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const ANNO_HTML_MAX_ASSETS = 64;

/** Decode complete HTML bytes; invalid UTF-8 throws. */
export function annoHtmlDecode(data) {
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

/** Encode binary asset bytes as base64 without a call-stack blow-up. */
export function annoHtmlBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Whether a reference addresses a sibling file this renderer may read. */
export function annoHtmlRelativeReference(reference) {
  return (
    typeof reference === 'string' &&
    reference.length > 0 &&
    !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference) &&
    !reference.includes('\u0000')
  );
}

/**
 * Decode a `dsh-resource://file/session/<id>/<path>` address into the session
 * an asset read runs under and the document's own path.
 * @param {string} address resource address
 * @returns {{sessionId: string, path: string} | null}
 */
export function annoHtmlFileScope(address) {
  if (typeof address !== 'string' || !address.startsWith('dsh-resource://file/')) return null;
  try {
    const end = address.search(/[?#]/);
    const raw = address.slice('dsh-resource://file/'.length, end === -1 ? undefined : end);
    const parts = raw.split('/');
    const scope = parts.shift();
    if (scope === 'session') {
      const sessionId = parts.shift();
      if (!sessionId || parts.length === 0) return null;
      const path = parts.map(decodeURIComponent).join('/');
      if (path === '') return null;
      return { sessionId: decodeURIComponent(sessionId), path };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append the bridge to a complete document.
 * @param {string} html complete HTML text
 * @returns {string}
 */
export function annoHtmlAppendBridge(html) {
  return String(html) + annoHtmlBridgeScript();
}

/**
 * Inline the document's classic scripts and stylesheets as data URLs and append
 * the bridge. Reads go through the runtime's bound workspace-file face; a
 * reference that cannot be read is left untouched so the page still renders.
 * @param {string} source complete HTML text
 * @param {{sessionId: string, path: string} | null} scope document scope
 * @param {object | null} runtime plugin runtime
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<string>} complete document for the iframe
 */
export async function annoHtmlPrepare(source, scope, runtime, signal) {
  if (!runtime || typeof runtime.readHtmlAsset !== 'function' || !scope || scope.sessionId === '') {
    return annoHtmlAppendBridge(source);
  }
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(source, 'text/html');
  } catch {
    return annoHtmlAppendBridge(source);
  }
  if (!doc || !doc.documentElement) return annoHtmlAppendBridge(source);
  // A base element moves resolution into the browser; do not second-guess it.
  if (doc.querySelector('base[href]') !== null) return annoHtmlAppendBridge(source);

  const items = [];
  for (const element of doc.querySelectorAll('script[src],link[href]')) {
    const script = element.localName === 'script';
    if (script) {
      const type = (element.getAttribute('type') || '').trim().toLowerCase();
      if (['', 'text/javascript', 'application/javascript'].includes(type) === false) continue;
    } else {
      const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet') === false) continue;
    }
    const reference = element.getAttribute(script ? 'src' : 'href');
    if (typeof reference !== 'string' || annoHtmlRelativeReference(reference) === false) continue;
    const pathPart = reference.split(/[?#]/)[0];
    if ((script ? /\.js$/iu : /\.css$/iu).test(pathPart) === false) continue;
    items.push({ element, script, reference });
  }
  if (items.length === 0) return annoHtmlAppendBridge(source);

  const seen = new Set();
  let total = source.length;
  let count = 0;
  for (const item of items) {
    if (signal && signal.aborted) throw new Error('annotation html pack aborted');
    if (count >= ANNO_HTML_MAX_ASSETS || total >= ANNO_HTML_MAX_TOTAL_BYTES) break;
    const key = (item.script ? 'script:' : 'style:') + item.reference;
    if (seen.has(key)) continue;
    const asset = await runtime.readHtmlAsset(scope.sessionId, item.reference, scope.path, signal);
    if (!asset || !asset.data) continue;
    const size = typeof asset.data.byteLength === 'number' ? asset.data.byteLength : 0;
    if (size === 0 || size > ANNO_HTML_MAX_ASSET_BYTES) continue;
    if (total + size > ANNO_HTML_MAX_TOTAL_BYTES) break;
    total += size;
    seen.add(key);
    count += 1;
    const mime = item.script ? 'text/javascript' : 'text/css';
    item.element.setAttribute(
      item.script ? 'src' : 'href',
      'data:' + mime + ';base64,' + annoHtmlBase64(asset.data),
    );
  }
  return annoHtmlAppendBridge('<!doctype html>' + doc.documentElement.outerHTML);
}

/**
 * The in-frame half. This function is serialized into the iframe document, so it
 * must be self-contained: no outer bindings, no imports, plain browser APIs only.
 * @param {{ns: string, colors: string[], uiAttr: string}} config bridge configuration
 */
export function annoHtmlBridgeMain(config) {
  var cfg = config || {};
  var NS = cfg.ns || 'dsh-annotation-html';
  var UI = cfg.uiAttr || 'data-dsh-anno-ui';
  var COLORS = Array.isArray(cfg.colors) ? cfg.colors : ['yellow'];
  var COLOR_CSS = {
    yellow: 'rgba(250, 204, 21, 0.42)',
    green: 'rgba(74, 222, 128, 0.40)',
    blue: 'rgba(96, 165, 250, 0.38)',
    pink: 'rgba(244, 114, 182, 0.35)',
  };
  var HIGHLIGHT_PREFIX = 'dsh-anno-';
  var FLASH_NAME = 'dsh-anno-flash';
  var MAX_TEXT = 400000;
  var MAX_QUOTE = 4000;
  var CONTEXT = 42;
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, CANVAS: 1,
    SVG: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, BUTTON: 1,
  };

  var pinsRoot = null;
  var pinEls = {};
  var rangesById = {};
  var annotationsById = {};
  var currentList = null;
  var lastReportKey = '';
  var lastReportAt = 0;
  var pointerDown = false;
  var selectionTimer = 0;
  var lastPointerUpAt = 0;
  var repaintTimer = 0;
  var scrollFrame = 0;

  function post(message) {
    try {
      if (!message || typeof message !== 'object') return;
      message.ns = NS;
      if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
    } catch (error) {
      /* the parent may be gone */
    }
  }

  function clampText(value, max) {
    if (typeof value !== 'string') return '';
    var clean = value.replace(/\u0000/g, '');
    return clean.length > max ? clean.slice(0, max) : clean;
  }

  function makeHiddenTest() {
    var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function check(element) {
      if (!element || element.nodeType !== 1) return false;
      if (cache && cache.has(element)) return cache.get(element);
      var hidden = false;
      if (typeof element.hasAttribute === 'function' && element.hasAttribute(UI)) hidden = true;
      else if (SKIP_TAGS[element.tagName]) hidden = true;
      else if (element.hidden) hidden = true;
      else {
        try {
          if (typeof element.checkVisibility === 'function') {
            hidden = !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
          } else {
            var style = window.getComputedStyle(element);
            hidden = style.display === 'none' || style.visibility === 'hidden';
          }
        } catch (error) {
          hidden = false;
        }
      }
      if (!hidden) hidden = check(element.parentElement);
      if (cache) cache.set(element, hidden);
      return hidden;
    }
    return check;
  }

  function collectTextNodes(root) {
    var hidden = makeHiddenTest();
    var nodes = [];
    var text = '';
    if (!root) return { text: text, nodes: nodes };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      var parent = node.parentElement;
      if (!parent || hidden(parent)) continue;
      var value = node.data;
      if (!value) continue;
      var start = text.length;
      text += value;
      nodes.push({ node: node, start: start, end: text.length });
      if (text.length >= MAX_TEXT) break;
    }
    return { text: text, nodes: nodes };
  }

  function offsetInNodes(collected, container, offset) {
    if (container.nodeType === 3) {
      for (var index = 0; index < collected.nodes.length; index += 1) {
        var item = collected.nodes[index];
        if (item.node === container) return item.start + Math.min(offset, container.data.length);
      }
      return null;
    }
    if (collected.nodes.length === 0) return 0;
    var probe = document.createRange();
    try {
      probe.setStart(container, offset);
      probe.collapse(true);
    } catch (error) {
      return null;
    }
    for (var position = 0; position < collected.nodes.length; position += 1) {
      var relation;
      try {
        relation = probe.comparePoint(collected.nodes[position].node, 0);
      } catch (error) {
        relation = 1;
      }
      if (relation >= 0) return collected.nodes[position].start;
    }
    return collected.nodes[collected.nodes.length - 1].end;
  }

  function rangeFromOffsets(nodes, start, end) {
    if (!Array.isArray(nodes) || end <= start) return null;
    var startNode = null;
    var startOffset = 0;
    var endNode = null;
    var endOffset = 0;
    for (var index = 0; index < nodes.length; index += 1) {
      var item = nodes[index];
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
    var range = document.createRange();
    try {
      range.setStart(startNode, Math.min(startOffset, startNode.data.length));
      range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
    } catch (error) {
      return null;
    }
    return range.collapsed ? null : range;
  }

  function clipRange(range, root) {
    if (!range || !root) return null;
    var bounds = document.createRange();
    try {
      bounds.selectNodeContents(root);
    } catch (error) {
      return null;
    }
    var clipped = range.cloneRange();
    try {
      if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
        clipped.setStart(bounds.startContainer, bounds.startOffset);
      }
      if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
        clipped.setEnd(bounds.endContainer, bounds.endOffset);
      }
    } catch (error) {
      return null;
    }
    return clipped.collapsed ? null : clipped;
  }

  function buildSegment(text, start, end) {
    if (typeof text !== 'string') return null;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (start < 0 || end <= start || end > text.length) return null;
    var raw = text.slice(start, end);
    if (raw.trim() === '') return null;
    return {
      exact: clampText(raw, MAX_QUOTE),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT),
      start: start,
    };
  }

  function commonPrefixLen(left, right) {
    var limit = Math.min(left.length, right.length);
    var index = 0;
    while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
    return index;
  }

  function commonSuffixLen(left, right) {
    var limit = Math.min(left.length, right.length);
    var index = 0;
    while (index < limit && left.charCodeAt(left.length - 1 - index) === right.charCodeAt(right.length - 1 - index)) {
      index += 1;
    }
    return index;
  }

  function resolveSegment(text, segment) {
    if (typeof text !== 'string' || !segment || typeof segment.exact !== 'string' || segment.exact === '') return null;
    var exact = segment.exact;
    var prefix = typeof segment.prefix === 'string' ? segment.prefix : '';
    var suffix = typeof segment.suffix === 'string' ? segment.suffix : '';
    var hint = typeof segment.start === 'number' && segment.start >= 0 ? segment.start : -1;
    var best = null;
    var from = 0;
    var seen = 0;
    while (seen < 200) {
      var index = text.indexOf(exact, from);
      if (index < 0) break;
      seen += 1;
      var before = text.slice(Math.max(0, index - prefix.length), index);
      var after = text.slice(index + exact.length, index + exact.length + suffix.length);
      var score = commonSuffixLen(prefix, before) + commonPrefixLen(suffix, after);
      if (index === hint) score += 0.5;
      if (best === null || score > best.score) best = { start: index, end: index + exact.length, score: score };
      from = index + Math.max(1, exact.length);
    }
    return best === null ? null : { start: best.start, end: best.end };
  }

  function rangeRect(range) {
    var rects = null;
    try {
      rects = range.getClientRects();
    } catch (error) {
      return null;
    }
    for (var index = rects.length - 1; index >= 0; index -= 1) {
      var rect = rects[index];
      if (rect.width > 0 || rect.height > 0) {
        return {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height,
        };
      }
    }
    return null;
  }

  function highlightSupported() {
    return typeof CSS !== 'undefined' && CSS !== null && !!CSS.highlights && typeof Highlight === 'function';
  }

  function ensureStyle() {
    if (document.querySelector('style[' + UI + ']') !== null) return;
    var style = document.createElement('style');
    style.setAttribute(UI, '');
    var rules = '';
    for (var index = 0; index < COLORS.length; index += 1) {
      var color = COLORS[index];
      rules += '::highlight(' + HIGHLIGHT_PREFIX + color + '){background-color:' + (COLOR_CSS[color] || COLOR_CSS.yellow) + ';}\n';
    }
    rules += '::highlight(' + FLASH_NAME + '){background-color:rgba(59,130,246,0.45);}\n';
    rules +=
      '[' + UI + ']{pointer-events:none;}\n' +
      '.dsh-anno-pin{position:fixed;z-index:2147483000;box-sizing:border-box;width:18px;height:18px;' +
      'border-radius:9px;border:1px solid rgba(0,0,0,0.28);background:#facc15;color:#111;' +
      "font:600 11px/16px system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center;" +
      'box-shadow:0 1px 3px rgba(0,0,0,0.28);cursor:pointer;pointer-events:auto;user-select:none;}\n' +
      '.dsh-anno-pin[data-sent="1"]{opacity:.55;}\n' +
      '.dsh-anno-pin:hover{transform:scale(1.12);}\n';
    style.textContent = rules;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensurePinsRoot() {
    if (pinsRoot !== null && pinsRoot.isConnected) return pinsRoot;
    pinsRoot = document.createElement('div');
    pinsRoot.setAttribute(UI, '');
    pinsRoot.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
    (document.body || document.documentElement).appendChild(pinsRoot);
    pinEls = {};
    return pinsRoot;
  }

  function positionPin(element, id) {
    var ranges = rangesById[id];
    if (!ranges || ranges.length === 0) {
      element.style.display = 'none';
      return;
    }
    var rect = rangeRect(ranges[0]);
    if (!rect) {
      element.style.display = 'none';
      return;
    }
    var left = Math.min(rect.right + 6, (window.innerWidth || 800) - 24);
    var top = rect.top + rect.height / 2 - 9;
    element.__annoRect = {
      left: left, top: top, right: left + 18, bottom: top + 18, width: 18, height: 18,
    };
    element.style.left = Math.round(left) + 'px';
    element.style.top = Math.round(top) + 'px';
    element.style.visibility = top < -20 || top > (window.innerHeight || 600) + 20 ? 'hidden' : 'visible';
  }

  function onPinClick(event) {
    event.preventDefault();
    event.stopPropagation();
    var target = event.currentTarget;
    var id = target.getAttribute('data-annotation-id');
    if (id) post({ type: 'hit', id: id, rect: target.__annoRect || null });
  }

  function renderPins() {
    var root = ensurePinsRoot();
    var wanted = {};
    for (var id in rangesById) {
      if (!Object.prototype.hasOwnProperty.call(rangesById, id)) continue;
      wanted[id] = true;
      var ann = annotationsById[id] || {};
      var element = pinEls[id];
      if (!element) {
        element = document.createElement('div');
        element.className = 'dsh-anno-pin';
        element.setAttribute(UI, '');
        element.setAttribute('data-dsh-anno-pin', '');
        element.addEventListener('click', onPinClick, true);
        root.appendChild(element);
        pinEls[id] = element;
      }
      element.setAttribute('data-annotation-id', id);
      element.textContent = ann.number ? String(ann.number) : '';
      element.style.display = ann.number ? 'block' : 'none';
      element.setAttribute('data-sent', ann.sent ? '1' : '0');
      positionPin(element, id);
    }
    for (var existing in pinEls) {
      if (!Object.prototype.hasOwnProperty.call(pinEls, existing)) continue;
      if (!wanted[existing]) {
        var node = pinEls[existing];
        if (node.parentNode) node.parentNode.removeChild(node);
        delete pinEls[existing];
      }
    }
  }

  function repositionPins() {
    for (var id in pinEls) {
      if (Object.prototype.hasOwnProperty.call(pinEls, id)) positionPin(pinEls[id], id);
    }
  }

  function scheduleReposition() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(function () {
      scrollFrame = 0;
      repositionPins();
    });
  }

  function applyPaint(list) {
    var items = Array.isArray(list) ? list : [];
    currentList = items;
    var root = document.body || document.documentElement;
    var collected = collectTextNodes(root);
    rangesById = {};
    annotationsById = {};
    var byColor = {};
    for (var colorIndex = 0; colorIndex < COLORS.length; colorIndex += 1) byColor[COLORS[colorIndex]] = [];
    for (var index = 0; index < items.length; index += 1) {
      var ann = items[index];
      if (!ann || typeof ann.id !== 'string') continue;
      annotationsById[ann.id] = ann;
      var ranges = [];
      var segments = Array.isArray(ann.segments) ? ann.segments : [];
      for (var segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        var resolved = resolveSegment(collected.text, segments[segmentIndex]);
        if (resolved === null) continue;
        var range = rangeFromOffsets(collected.nodes, resolved.start, resolved.end);
        if (range !== null) ranges.push(range);
      }
      if (ranges.length === 0) continue;
      rangesById[ann.id] = ranges;
      var bucket = byColor[ann.color];
      if (bucket) {
        for (var rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) bucket.push(ranges[rangeIndex]);
      }
    }
    if (highlightSupported()) {
      for (var paintIndex = 0; paintIndex < COLORS.length; paintIndex += 1) {
        var color = COLORS[paintIndex];
        var name = HIGHLIGHT_PREFIX + color;
        var rangesForColor = byColor[color] || [];
        try {
          if (rangesForColor.length === 0) {
            CSS.highlights.delete(name);
          } else {
            var highlight = new Highlight();
            for (var rangeIndex = 0; rangeIndex < rangesForColor.length && rangeIndex < 2000; rangeIndex += 1) {
              highlight.add(rangesForColor[rangeIndex]);
            }
            CSS.highlights.set(name, highlight);
          }
        } catch (error) {
          try {
            CSS.highlights.delete(name);
          } catch (ignored) {
            /* nothing to clear */
          }
        }
      }
    }
    renderPins();
  }

  function flash(ranges) {
    if (highlightSupported() === false || !ranges || ranges.length === 0) return;
    try {
      var highlight = new Highlight();
      for (var index = 0; index < ranges.length && index < 50; index += 1) highlight.add(ranges[index]);
      CSS.highlights.set(FLASH_NAME, highlight);
    } catch (error) {
      return;
    }
    if (flash.timer) window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(function () {
      try {
        CSS.highlights.delete(FLASH_NAME);
      } catch (error) {
        /* already gone */
      }
    }, 1600);
  }

  function reveal(id) {
    var ranges = rangesById[id];
    if (!ranges || ranges.length === 0) return;
    var first = ranges[0];
    var element = first.startContainer && first.startContainer.parentElement;
    if (element) {
      try {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch (error) {
        /* options bag unsupported */
      }
    }
    flash(ranges);
    window.setTimeout(repositionPins, 80);
    window.setTimeout(repositionPins, 600);
  }

  function hitTest(clientX, clientY) {
    var caret = null;
    try {
      if (typeof document.caretRangeFromPoint === 'function') {
        caret = document.caretRangeFromPoint(clientX, clientY);
      } else if (typeof document.caretPositionFromPoint === 'function') {
        var position = document.caretPositionFromPoint(clientX, clientY);
        if (position) {
          caret = document.createRange();
          caret.setStart(position.offsetNode, position.offset);
          caret.collapse(true);
        }
      }
    } catch (error) {
      caret = null;
    }
    if (!caret) return null;
    var container = caret.startContainer;
    var offset = caret.startOffset;
    for (var id in rangesById) {
      if (!Object.prototype.hasOwnProperty.call(rangesById, id)) continue;
      var ranges = rangesById[id];
      for (var index = 0; index < ranges.length; index += 1) {
        var inside = false;
        try {
          inside = ranges[index].comparePoint(container, offset) === 0;
        } catch (error) {
          inside = false;
        }
        if (inside) return { id: id, rect: rangeRect(ranges[index]) };
      }
    }
    return null;
  }

  function captureSelection() {
    var selection = null;
    try {
      selection = window.getSelection();
    } catch (error) {
      return null;
    }
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    var root = document.body || document.documentElement;
    var clipped = clipRange(range, root);
    if (clipped === null) return null;
    var collected = collectTextNodes(root);
    var start = offsetInNodes(collected, clipped.startContainer, clipped.startOffset);
    var end = offsetInNodes(collected, clipped.endContainer, clipped.endOffset);
    var segment = null;
    if (start !== null && end !== null && end > start) segment = buildSegment(collected.text, start, end);
    if (segment === null) {
      var raw = '';
      try {
        raw = clipped.toString();
      } catch (error) {
        raw = '';
      }
      if (raw.trim() !== '') segment = { exact: clampText(raw, MAX_QUOTE), prefix: '', suffix: '', start: 0 };
    }
    if (segment === null) return null;
    var rect = rangeRect(clipped);
    if (rect === null) return null;
    return { segment: segment, rect: rect, text: segment.exact };
  }

  function reportSelection() {
    if (pointerDown) return;
    var payload = captureSelection();
    if (payload === null) return;
    var key = payload.segment.exact.slice(0, 80) + '|' + Math.round(payload.rect.left) + ',' + Math.round(payload.rect.top);
    var now = Date.now();
    if (key === lastReportKey && now - lastReportAt < 1200) return;
    lastReportKey = key;
    lastReportAt = now;
    post({ type: 'selection', segment: payload.segment, rect: payload.rect, text: payload.text });
  }

  function isOwnUi(target) {
    return !!target && typeof target.closest === 'function' && target.closest('[' + UI + ']') !== null;
  }

  function onPointerDown(event) {
    pointerDown = true;
    if (isOwnUi(event.target)) return;
    post({ type: 'dismiss' });
  }

  function onPointerUp(event) {
    pointerDown = false;
    lastPointerUpAt = Date.now();
    if (isOwnUi(event.target)) return;
    var clientX = event.clientX;
    var clientY = event.clientY;
    window.setTimeout(function () {
      var payload = captureSelection();
      if (payload !== null) {
        reportSelection();
        return;
      }
      var hit = hitTest(clientX, clientY);
      if (hit && hit.rect) post({ type: 'hit', id: hit.id, rect: hit.rect });
    }, 0);
  }

  function onMouseUp(event) {
    if (Date.now() - lastPointerUpAt < 400) return;
    onPointerUp(event);
  }

  function onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      post({ type: 'dismiss' });
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) post({ type: 'send' });
  }

  function onKeyUp(event) {
    if (event.key === 'Escape') {
      post({ type: 'dismiss' });
      return;
    }
    var selectionKey = event.shiftKey || ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A'));
    if (!selectionKey) return;
    window.setTimeout(reportSelection, 0);
  }

  function onSelectionChange() {
    if (pointerDown) return;
    var selection = null;
    try {
      selection = window.getSelection();
    } catch (error) {
      return;
    }
    if (!selection || selection.isCollapsed) return;
    if (selectionTimer) window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(function () {
      selectionTimer = 0;
      reportSelection();
    }, 450);
  }

  function onScroll() {
    scheduleReposition();
  }

  function onMessage(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.ns !== NS) return;
    if (data.type === 'paint') {
      applyPaint(data.annotations);
      return;
    }
    if (data.type === 'reveal' && typeof data.id === 'string') reveal(data.id);
    if (data.type === 'clear') {
      lastReportKey = '';
      try {
        var selection = window.getSelection();
        if (selection) selection.removeAllRanges();
      } catch (error) {
        /* a frame without a selection */
      }
    }
  }

  function announce() {
    ensureStyle();
    if (!pinsRoot || !pinsRoot.isConnected) {
      pinsRoot = null;
      pinEls = {};
    }
    if (currentList !== null) applyPaint(currentList);
    post({ type: 'ready' });
  }

  ensureStyle();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('selectionchange', onSelectionChange, false);
  window.addEventListener('message', onMessage, false);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, false);
  window.addEventListener('load', announce, false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce, false);
  else announce();

  // Pages that fill themselves in after load get their stored quotes re-resolved;
  // annotation-owned nodes are skipped so our own pins never wake the observer.
  try {
    var observer = new MutationObserver(function (mutations) {
      if (currentList === null) return;
      var relevant = false;
      for (var index = 0; index < mutations.length; index += 1) {
        var target = mutations[index].target;
        if (pinsRoot && target && (target === pinsRoot || pinsRoot.contains(target))) continue;
        relevant = true;
        break;
      }
      if (!relevant) return;
      if (repaintTimer) window.clearTimeout(repaintTimer);
      repaintTimer = window.setTimeout(function () {
        repaintTimer = 0;
        applyPaint(currentList);
      }, 350);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) {
    /* mutation observation is an enhancement */
  }
}

/** The palette, shared with the bundle's core when it is present. */
function annoHtmlPalette() {
  return typeof ANNO_COLORS !== 'undefined' && Array.isArray(ANNO_COLORS)
    ? ANNO_COLORS
    : ['yellow', 'green', 'blue', 'pink'];
}

/** Serialized bridge for one iframe document. */
export function annoHtmlBridgeScript() {
  const config = JSON.stringify({ ns: ANNO_HTML_NS, colors: annoHtmlPalette(), uiAttr: ANNO_HTML_UI_ATTR })
    .replace(/</g, '\\u003c');
  return '<script>(' + annoHtmlBridgeMain.toString() + ')(' + config + ');</script>';
}

/**
 * The document body rendered under `sidebar.right.tab.document` for the
 * annotation implementation. It builds the frame's document in the parent
 * (asset reads happen under the file's own authority), keeps the opaque
 * sandbox, and registers the frame so the runtime can talk to its bridge.
 * @param {object} props slot props plus the injected runtime
 */
export function AnnoHtmlBody(props) {
  const runtime = props.runtime || null;
  const content = props.content || null;
  const address = typeof props.resourceAddress === 'string' ? props.resourceAddress : '';
  const t = typeof props.t === 'function' ? props.t : (key) => String(key);
  const state = React.useState({ html: '', status: 'loading' });
  const view = state[0];
  const setView = state[1];
  const frameRef = React.useRef(null);
  const entryRef = React.useRef(null);

  const unregister = () => {
    if (entryRef.current && typeof entryRef.current === 'function') {
      try {
        entryRef.current();
      } catch {
        /* already gone */
      }
    }
    entryRef.current = null;
  };

  const bindFrame = React.useCallback((iframe) => {
    frameRef.current = iframe;
    unregister();
    if (!iframe || !runtime || typeof runtime.registerHtmlFrame !== 'function') return;
    const scope = annoHtmlFileScope(address);
    entryRef.current = runtime.registerHtmlFrame({
      iframe,
      docKey: address,
      path: scope ? scope.path : '',
    });
    iframe.setAttribute('data-dsh-anno-html-frame', '');
  }, [runtime, address]);

  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!content || content.kind !== 'bytes' || !content.data) {
      setView({ html: '', status: 'unsupported' });
      return () => controller.abort();
    }
    let source = '';
    try {
      source = annoHtmlDecode(content.data);
    } catch {
      setView({ html: '', status: 'failed' });
      return () => controller.abort();
    }
    setView({ html: '', status: 'loading' });
    const scope = annoHtmlFileScope(address);
    Promise.resolve()
      .then(() => annoHtmlPrepare(source, scope, runtime, controller.signal))
      .then((html) => {
        if (active && !controller.signal.aborted) setView({ html, status: 'ready' });
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setView({ html: '', status: 'failed' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [content, address, runtime]);

  React.useEffect(() => () => unregister(), []);

  if (view.status === 'unsupported') return null;
  if (view.status === 'failed') {
    return h('p', {
      className: 'anno-html-status',
      role: 'alert',
      style: { margin: 0, padding: '10px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', whiteSpace: 'normal' },
    }, t('html.failed'));
  }
  if (view.status !== 'ready') {
    return h('p', {
      className: 'anno-html-status',
      style: { margin: 0, padding: '10px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', whiteSpace: 'normal' },
    }, t('html.loading'));
  }
  return h('iframe', {
    ref: bindFrame,
    className: 'anno-html-frame',
    sandbox: 'allow-scripts',
    srcDoc: view.html,
    title: t('html.frame'),
    onLoad: () => {
      if (runtime && typeof runtime.repaint === 'function') runtime.repaint();
    },
    style: {
      display: 'block',
      width: '100%',
      height: '100%',
      minHeight: '240px',
      border: 'none',
      background: 'var(--dsw-alias-bg-base, #fff)',
    },
  });
}
