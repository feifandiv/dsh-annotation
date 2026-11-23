/**
 * Plugin body: registers the annotation runtime, its stylesheet, its DOM
 * engine and the client surfaces (frame overlay, composer card, send bridge,
 * and the annotatable HTML document renderer).
 *
 * Every surface is an additive slot entry with a fresh id, so no shipped UI is
 * replaced. The runtime owns every listener; unloading the plugin removes the
 * stylesheet, the listeners, the observers and the painted highlights.
 */

const ANNO_NS = 'annotation';
const ANNO_INJECT = ['slots', 'locale', 'sessions', 'sidebarRight'];
const ANNO_PLUGIN_ID = 'dsh-annotation';

/** Enable or retire the annotatable renderer as the interactive-preview setting changes. */
function annoSyncHtmlPreview(runtime) {
  const enabled = annoHtmlDeveloperToolsEnabled(runtime.ctx);
  if (enabled === true) {
    annoRegisterHtmlPreview(runtime);
    return;
  }
  if (enabled === false && typeof runtime.htmlPreview === 'function') {
    try {
      runtime.htmlPreview();
    } catch {
      /* already disposed */
    }
    runtime.htmlPreview = null;
    runtime.htmlPreviewRegistered = false;
    runtime.htmlPreviewAttempts = 0;
  }
}

/** Last mounted runtime, for the optional debugging handle. */
let annoRuntimeInstance = null;

/**
 * Register the annotatable HTML document implementation.
 *
 * The builtin HTML preview isolates the page in an opaque-origin iframe, so it
 * cannot be annotated from the parent. This renderer claims `.html`/`.htm` in
 * the higher `extension` band, runs the page in the same sandbox and adds a
 * bridge inside; the builtin implementation stays selectable in the preview's
 * own implementation menu. It only takes over while the host's interactive
 * preview runs pages with script permission.
 *
 * @param {object} runtime annotation runtime
 * @returns {(() => void) | null} disposer, or null while the registry is not ready
 */
function annoRegisterHtmlPreview(runtime) {
  if (typeof runtime.htmlPreview === 'function') return runtime.htmlPreview;
  if ((runtime.htmlPreviewAttempts || 0) >= 24) return null;
  runtime.htmlPreviewAttempts = (runtime.htmlPreviewAttempts || 0) + 1;
  const ctx = runtime.ctx;
  if (!ctx || typeof ctx.get !== 'function') return null;

  // Without script permission the host's static, sanitized preview is the
  // correct default; an annotatable copy would silently weaken it. The
  // preference starts false until the settings document arrives, so a `false`
  // answer is retried rather than locked in.
  if (annoHtmlDeveloperToolsEnabled(ctx) !== true) return null;

  let previews = null;
  try {
    previews = ctx.get('documentPreviews');
  } catch {
    previews = null;
  }
  if (!previews || typeof previews.register !== 'function') return null;

  let disposeRegistry = null;
  try {
    disposeRegistry = previews.register({
      id: ANNO_HTML_BODY_ID,
      extensions: ANNO_HTML_EXTENSIONS.slice(),
      priority: 'extension',
      title: () => (annoIsChineseLocale(runtime) ? 'HTML（可标注）' : 'HTML (annotatable)'),
      loading: 'bytes-complete',
      wrap: false,
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!message.includes('duplicate')) {
      console.warn('[annotation] html document renderer registration failed', error);
      return null;
    }
    // A previous instance of this plugin already owns the registration.
    disposeRegistry = null;
  }

  let disposeSlot = null;
  try {
    disposeSlot = ctx.slots.inject('sidebar.right.tab.document', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.tab.document',
          key: ANNO_HTML_BODY_ID,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoHtmlBody,
      ),
    );
  } catch (error) {
    console.warn('[annotation] html document body registration failed', error);
    if (typeof disposeRegistry === 'function') {
      try {
        disposeRegistry();
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  const dispose = () => {
    runtime.htmlPreviewAttempts = 0;
    if (typeof disposeSlot === 'function') {
      try {
        disposeSlot();
      } catch {
        /* ignore */
      }
    }
    if (typeof disposeRegistry === 'function') {
      try {
        disposeRegistry();
      } catch {
        /* ignore */
      }
    }
  };
  runtime.htmlPreview = dispose;
  runtime.htmlPreviewRegistered = true;
  annoWriteDiag(runtime, 'html-preview-registered');
  return dispose;
}

/**
 * @param {object} ctx client plugin context (slots + locale services)
 */
function annoApply(ctx) {
  ctx.effect(
    () =>
      ctx.locale.register(ANNO_NS, {
        zh: ANNO_ZH,
        en: ANNO_EN,
      }),
    'annotation: dictionaries',
  );

  const runtime = annoCreateRuntime(ctx);
  annoRuntimeInstance = runtime;
  if (!runtime.supportsHighlight) {
    console.warn('[annotation] CSS Custom Highlight API unavailable; annotations are stored but not painted');
  }

  // Sent annotations are transient: the message carries every quote and note,
  // so a batch left over from an earlier round is dropped on load.
  runtime.cleanupSentAnnotations();

  ctx.effect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', ANNO_PLUGIN_ID);
    style.setAttribute('data-plugin-css', ANNO_PLUGIN_ID + '/client.css');
    style.textContent = annoPluginCss() + annoCompatCss();
    const parent = document.head || document.documentElement;
    parent.appendChild(style);
    runtime.diag.styleInjected = true;
    annoWriteDiag(runtime, 'style-injected');
    return () => {
      runtime.diag.styleInjected = false;
      style.remove();
    };
  }, 'annotation: stylesheet');

  ctx.effect(() => annoAttachEngine(runtime), 'annotation: selection and mutation engine');

  // The document registry and the settings service publish at their own pace,
  // so the renderer registration retries briefly instead of failing once.
  ctx.effect(() => {
    let unwatch = null;
    const sync = () => {
      if (unwatch === null) unwatch = annoWatchDeveloperTools(runtime, sync);
      annoSyncHtmlPreview(runtime);
    };
    sync();
    const timers = [600, 1800, 4000, 9000, 16000, 30000].map((ms) => window.setTimeout(sync, ms));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      if (typeof unwatch === 'function') {
        try {
          unwatch();
        } catch {
          /* already gone */
        }
      }
    };
  }, 'annotation: annotatable html renderer');

  // Chat annotations of deleted sessions are dead weight; prune them once the
  // session index has settled (retries tolerate a slow startup).
  ctx.effect(() => {
    const timers = [8000, 25000, 60000].map((ms) => window.setTimeout(() => runtime.pruneDeletedSessions(), ms));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, 'annotation: orphan cleanup');

  ctx.effect(() => {
    const onStorage = (event) => {
      if (event && event.key === ANNO_STORAGE_KEY) runtime.store.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, 'annotation: cross-window sync');

  // Each surface is registered independently: a slot unavailable in some
  // composition must not prevent the other surface (or the plugin) from loading.
  try {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'annotation.overlay',
          order: 40,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoOverlay,
      ),
    );
  } catch (error) {
    console.warn('[annotation] shell.overlay registration failed', error);
  }

  try {
    ctx.slots.inject('conversation.input.overlay', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.overlay',
          id: 'annotation.pending',
          order: 10,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoPendingCard,
      ),
    );
  } catch (error) {
    console.warn('[annotation] pending card registration failed', error);
  }

  try {
    ctx.slots.inject('conversation.composer.dock', () =>
      ctx.slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'annotation.send-bridge',
          order: 100,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoSendBridge,
      ),
    );
  } catch (error) {
    console.warn('[annotation] composer send bridge registration failed', error);
  }

  annoWriteDiag(runtime, 'applied');

  // Small diagnostics handle: lets a user (or the author) inspect the live
  // state from DevTools without hunting through internal objects.
  ctx.effect(() => {
    const handle = {
      version: '2.5.0',
      runtime,
      state: () => runtime.state,
      annotations: () => runtime.store.list(),
      repaint: () => runtime.repaint(),
      supportsHighlight: () => runtime.supportsHighlight,
      probe: () => ({
        highlight: runtime.supportsHighlight,
        engineAttached: runtime.diag.engineAttached,
        styleInjected: runtime.diag.styleInjected,
        captureAttempts: runtime.diag.captureAttempts,
        lastCapture: runtime.diag.lastCapture,
        lastPointer: runtime.diag.lastPointer,
        annotations: runtime.store.list().length,
        sessions: document.querySelectorAll('[data-conversation-session]').length,
        chatRows: document.querySelectorAll('[data-chat-anchor-key]').length,
        assistantRows: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
        docs: document.querySelectorAll('[data-textpreview-url]').length,
        docBodies: document.querySelectorAll('[data-textpreview-body]').length,
        htmlFrames: document.querySelectorAll('iframe[data-dsh-anno-html-frame]').length,
        toolbar: runtime.state.toolbar !== null,
        editor: runtime.state.editor !== null,
        composerMerge: runtime.diag.composerMerge || null,
        currentSessionId: runtime.state.currentSessionId,
      }),
      hideForeignSelectionPopup: (enabled) => {
        annoSetHideForeignPopup(enabled === true);
        return 'hideForeignSelectionPopup=' + (enabled === true ? 'on' : 'off') + ' (refresh the page to apply)';
      },
      enableDiagnostics: () => {
        annoSetDebug(runtime, true);
        return 'diagnostics enabled: ' + ANNO_DIAG_KEY;
      },
      disableDiagnostics: () => {
        annoSetDebug(runtime, false);
        return 'diagnostics disabled';
      },
      selfTest: () => annoRunSelfTest(runtime),
      editorProbe: () => {
        const area = document.querySelector('.anno-editor textarea');
        const active = document.activeElement;
        return {
          editorOpen: runtime.state.editor !== null,
          textareaExists: area !== null,
          activeIsTextarea: area !== null && active === area,
          activeTag: active ? active.tagName : null,
          activeClass: active && typeof active.className === 'string' ? active.className : null,
          rect: area ? area.getBoundingClientRect().toJSON() : null,
          pointerEvents: area ? getComputedStyle(area).pointerEvents : null,
          inertAncestor: area ? area.closest('[inert]') !== null : null,
          readOnly: area ? area.readOnly : null,
          disabled: area ? area.disabled : null,
        };
      },
      captureNow: () => {
        try {
          return annoCaptureSelection(runtime);
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      },
      sendReady: () => annoConversationFor(runtime, runtime.state.currentSessionId) !== null,
      html: () => ({
        registered: runtime.htmlPreviewRegistered === true,
        implementation: ANNO_HTML_BODY_ID,
        developerTools: annoHtmlDeveloperToolsEnabled(ctx),
        frames: annoHtmlFrames(runtime).map((entry) => ({
          docKey: entry.docKey,
          path: entry.path,
          ready: entry.ready === true,
        })),
      }),
      diagKey: 'dsh.annotation.diag.v1',
      writeDiag: (event) => annoWriteDiag(runtime, event || 'manual'),
      selectors: {
        chatRow: '[data-chat-anchor-key]',
        conversation: '[data-conversation-session]',
        document: '[data-textpreview-url]',
        documentBody: '[data-textpreview-body]',
      },
    };
    window.__dshAnnotation = handle;
    return () => {
      if (window.__dshAnnotation === handle) delete window.__dshAnnotation;
      annoRuntimeInstance = null;
      runtime.dispose();
    };
  }, 'annotation: runtime lifecycle');
}
