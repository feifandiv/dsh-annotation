/**
 * Plugin body: registers the annotation runtime, its stylesheet, its DOM
 * engine and the two client surfaces (frame overlay and sidebar trigger).
 *
 * Both surfaces are additive list entries with fresh ids, so no shipped UI is
 * replaced. The runtime owns every listener; unloading the plugin removes the
 * stylesheet, the listeners, the observers and the painted highlights.
 */

const ANNO_NS = 'annotation';
const ANNO_INJECT = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'];
const ANNO_PLUGIN_ID = 'dsh-annotation';

/** Last mounted runtime, for the optional debugging handle. */
let annoRuntimeInstance = null;

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

  // Native right-sidebar tab type: the annotation list docks beside documents
  // instead of covering the conversation in a centered dialog. The registry is
  // injected above, and the runtime keeps a lazy retry for compositions that
  // mount it late.
  runtime.registerAnnotationsTab();
  // Document annotations are transient by design: a sent PDF/doc highlight
  // must not survive into the next modification round.
  runtime.cleanupSentDocuments();

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

  try {
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'annotation.trigger',
          order: 20,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoFooterButton,
      ),
    );
  } catch (error) {
    console.warn('[annotation] sidebar.footer.action registration failed', error);
  }

  try {
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: ANNO_TAB_ID,
          locale: ANNO_NS,
          inject: () => ({ runtime }),
        },
        AnnoSidebarBody,
      ),
    );
  } catch (error) {
    console.warn('[annotation] sidebar tab body registration failed', error);
  }

  annoWriteDiag(runtime, 'applied');

  // Small diagnostics handle: lets a user (or the author) inspect the live
  // state from DevTools without hunting through internal objects.
  ctx.effect(() => {
    const handle = {
      version: '2.2.0',
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
        toolbar: runtime.state.toolbar !== null,
        editor: runtime.state.editor !== null,
        composerMerge: runtime.diag.composerMerge || null,
        annotationsTab: runtime.tabRegistered === true,
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
      openAnnotations: () => runtime.openAnnotationsTab(),
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
