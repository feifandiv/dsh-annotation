/**
 * React surface of the annotation plugin: a frame-wide overlay (highlight
 * toolbar, note editor, annotation list, toast) and the sidebar-foot trigger.
 *
 * All surfaces are rendered through `shell.overlay` / `sidebar.footer.action`
 * slots, inherit the host theme, and carry data-dsh-anno-ui so the engine can
 * ignore pointer events and text selection that originate inside them.
 */

/** The slot-provided translator, or a passthrough when the owner projects none. */
function annoTranslate(props) {
  if (props && typeof props.t === 'function') return props.t;
  return (key) => String(key);
}

/** Subscribe a component to runtime state changes. */
function annoUseRuntime(runtime) {
  const [, force] = React.useState(0);
  React.useEffect(() => runtime.subscribe(() => force((value) => value + 1)), [runtime]);
}

function annoClampNumber(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Viewport placement for the inline annotation composer. */
function annoPlaceComposer(rect, below) {
  const width = 360;
  const height = 132;
  const viewportWidth = window.innerWidth || 1024;
  const viewportHeight = window.innerHeight || 768;
  const left = annoClampNumber((rect ? rect.left : viewportWidth / 2) - 8, 8, viewportWidth - width - 8);
  if (below) {
    const down = (rect ? rect.bottom : viewportHeight / 2) + 12;
    if (down + height <= viewportHeight - 8) return { left: left, top: down };
  }
  const up = (rect ? rect.top : viewportHeight / 2) - height - 10;
  if (up >= 8) return { left: left, top: up };
  const down = (rect ? rect.bottom : viewportHeight / 2) + 12;
  return { left: left, top: annoClampNumber(down, 8, viewportHeight - height - 8) };
}



/** Small inline icon set drawn with currentColor. */
function AnnoIcon(props) {
  const size = props.size || 16;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  };
  switch (props.name) {
    case 'highlighter':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M12.9 3.6a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8l-7.3 7.3-3.6.9.9-3.6z' }),
        h('path', { key: 'b', d: 'M4.2 16.4h11.6' }),
      ]);
    case 'copy':
      return h('svg', common, [
        h('rect', { key: 'a', x: '7.5', y: '7.5', width: '9', height: '9', rx: '2' }),
        h('path', { key: 'b', d: 'M12.5 7.5V5.8A1.8 1.8 0 0 0 10.7 4H5.3A1.3 1.3 0 0 0 4 5.3v5.4a1.8 1.8 0 0 0 1.8 1.8h1.7' }),
      ]);
    case 'trash':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M4.5 6h11' }),
        h('path', { key: 'b', d: 'M6.2 6l.6 9.1a1.4 1.4 0 0 0 1.4 1.3h3.6a1.4 1.4 0 0 0 1.4-1.3L13.8 6' }),
        h('path', { key: 'c', d: 'M8.1 6V4.6A1.1 1.1 0 0 1 9.2 3.5h1.6a1.1 1.1 0 0 1 1.1 1.1V6' }),
      ]);
    case 'jump':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M4.2 15.8L15.6 4.4' }),
        h('path', { key: 'b', d: 'M8.2 4.4h7.4v7.4' }),
      ]);
    case 'close':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M5.2 5.2l9.6 9.6' }),
        h('path', { key: 'b', d: 'M14.8 5.2l-9.6 9.6' }),
      ]);
    case 'download':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M10 3.6v8.2' }),
        h('path', { key: 'b', d: 'M6.6 8.8L10 12.2l3.4-3.4' }),
        h('path', { key: 'c', d: 'M4.4 15.2h11.2' }),
      ]);
    case 'note':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M4.5 15.5l.8-3.4 7.2-7.2a1.6 1.6 0 0 1 2.3 0l.3.3a1.6 1.6 0 0 1 0 2.3l-7.2 7.2z' }),
      ]);
    case 'check':
      return h('svg', common, [h('path', { key: 'a', d: 'M4.6 10.4l3.4 3.4 7.4-7.6' })]);
    case 'chevron-up':
      return h('svg', common, [h('path', { key: 'a', d: 'M5.2 12.4L10 7.6l4.8 4.8' })]);
    case 'chevron-down':
      return h('svg', common, [h('path', { key: 'a', d: 'M5.2 7.6L10 12.4l4.8-4.8' })]);
    default:
      return h('svg', common, h('circle', { cx: '10', cy: '10', r: '6' }));
  }
}

/**
 * Floating comment box for a fresh selection: type the note and press Enter to
 * confirm; Cmd/Ctrl+Enter confirms and sends the whole pending batch. The note
 * input is the only control besides a confirm button.
 */
function AnnoToolbar(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  const payload = props.payload;
  const [note, setNote] = React.useState('');
  const inputRef = React.useRef(null);
  const style = annoPlaceComposer(payload.rect, payload.source === 'document');

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      const area = inputRef.current;
      if (!area) return;
      try {
        area.focus();
        area.click();
      } catch {
        /* focus is best-effort */
      }
    }, 30);
    return () => window.clearTimeout(handle);
  }, []);

  const confirm = (send) => {
    const annotation = runtime.commitAnnotation(note);
    if (annotation === null) return;
    if (send === true) runtime.sendPendingAnnotations();
  };

  return h(
    'div',
    {
      className: 'anno-toolbar anno-composer',
      style: style,
      role: 'dialog',
      'aria-label': t('toolbar.placeholder'),
      'data-dsh-anno-ui': '',
    },
    h('textarea', {
      ref: inputRef,
      className: 'anno-composer-input',
      value: note,
      rows: 2,
      placeholder: t('toolbar.placeholder'),
      'aria-label': t('toolbar.placeholder'),
      onChange: (event) => setNote(event.target.value),
      // Focusing the comment box collapses the document selection. When the
      // textarea itself has no selection, Cmd/Ctrl+C (or Edit → Copy) copies
      // the passage that opened the box instead of copying nothing.
      onCopy: (event) => {
        const area = event.currentTarget;
        if (!area || area.selectionStart !== area.selectionEnd) return;
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text === '') return;
        event.preventDefault();
        try {
          if (event.clipboardData) event.clipboardData.setData('text/plain', text);
          else annoCopyPlain(text);
          runtime.setNotice('copied');
        } catch {
          /* let the browser fall back when the clipboard is unavailable */
        }
      },
      onKeyDown: (event) => {
        // Let the IME commit its composition: Enter there selects a candidate,
        // it must not confirm and dismiss the comment box.
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          runtime.setToolbar(null);
          return;
        }
        if (event.key !== 'Enter') return;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          confirm(true);
          return;
        }
        if (event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        confirm(false);
      },
    }),
    h(
      'div',
      { className: 'anno-composer-row' },
      h('span', { className: 'anno-composer-hint' }, t('toolbar.hint')),
      h(
        'button',
        {
          type: 'button',
          className: 'anno-check',
          title: t('toolbar.confirm'),
          'aria-label': t('toolbar.confirm'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => confirm(false),
        },
        h(AnnoIcon, { name: 'check', size: 16 }),
      ),
    ),
  );
}

/**
 * Note editor for one annotation: a centered modal over a scrim, so input
 * never depends on the floating layer's geometry, an anchored popover's
 * stacking, or the surrounding preview's own selection UI. Events inside the
 * card are stopped before bubble-phase application handlers can react.
 */
function AnnoEditor(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  const editor = props.editor;
  const annotation = runtime.store.find(editor.id);
  const [note, setNote] = React.useState(annotation === null ? '' : annotation.note);
  const [saved, setSaved] = React.useState(false);
  const areaRef = React.useRef(null);
  const cardRef = React.useRef(null);
  const savedTimerRef = React.useRef(0);

  React.useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const handle = window.setTimeout(() => {
      try {
        area.focus();
        area.click();
        const length = area.value.length;
        area.setSelectionRange(length, length);
      } catch {
        /* focus is best-effort */
      }
    }, 40);
    return () => window.clearTimeout(handle);
  }, [editor.id]);

  React.useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const stop = (event) => {
      if (event.type === 'keydown' && event.key === 'Escape') return;
      event.stopPropagation();
    };
    const types = ['pointerdown', 'mousedown', 'click', 'keydown', 'keypress', 'input'];
    for (const type of types) card.addEventListener(type, stop, false);
    return () => {
      for (const type of types) card.removeEventListener(type, stop, false);
    };
  }, []);

  React.useEffect(
    () => () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    },
    [],
  );

  if (annotation === null) return null;

  const changeNote = (value) => {
    setNote(value);
    runtime.patchNote(annotation.id, value);
    setSaved(true);
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSaved(false), 1200);
  };
  const close = () => runtime.setEditor(null);

  return h(
    'div',
    {
      className: 'anno-editor-scrim',
      style: { position: 'fixed', inset: 0, zIndex: 1210, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.28)' },
      'data-dsh-anno-ui': '',
      onPointerDown: (event) => {
        if (event.target === event.currentTarget) close();
      },
    },
    h(
      'div',
      {
        ref: cardRef,
        className: 'anno-editor',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('panel.title'),
        'data-dsh-anno-ui': '',
        onPointerDown: (event) => event.stopPropagation(),
      },
      h(
        'div',
        { className: 'anno-editor-head' },
        h('span', { className: 'anno-editor-title' }, t('editor.title')),
        h('span', { className: 'anno-editor-saved' }, saved ? t('editor.saved') : ''),
      ),
      h('textarea', {
        ref: areaRef,
        className: 'anno-editor-note',
        value: note,
        rows: 4,
        autoFocus: true,
        placeholder: t('editor.placeholder'),
        'aria-label': t('editor.placeholder'),
        onChange: (event) => changeNote(event.target.value),
        onKeyDown: (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key !== 'Enter') return;
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
            runtime.sendPendingAnnotations();
            return;
          }
          if (event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        },
      }),
      h('div', { className: 'anno-editor-hint' }, t('editor.hint')),
      h(
        'div',
        { className: 'anno-editor-footer' },
        h(
          'button',
          { type: 'button', className: 'anno-text-btn anno-text-btn-danger', onClick: () => runtime.removeAnnotation(annotation.id) },
          t('editor.delete'),
        ),
        h('button', { type: 'button', className: 'anno-text-btn anno-text-btn-primary', onClick: close }, t('editor.close')),
      ),
    ),
  );
}

/** One annotation row inside the right-sidebar list. */
function AnnoSidebarRow(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  const annotation = props.annotation;
  const sourceLabel = props.sourceLabel;
  const number = props.number || 0;
  const quote = annoQuotePreview(annotation, 120);
  const note = typeof annotation.note === 'string' ? annotation.note.trim() : '';

  const jump = () => {
    const open = runtime.state.openDocs.some(
      (entry) =>
        entry.docKey === annotation.docKey ||
        (typeof annotation.path === 'string' && annotation.path !== '' && entry.path === annotation.path),
    );
    if (annotation.source === 'document' && !open) {
      Promise.resolve(runtime.openDocument(annotation.docKey)).then((opened) => {
        if (!opened) {
          runtime.setNotice('openFailed');
          return;
        }
        window.setTimeout(() => runtime.reveal(annotation), 900);
      });
      return;
    }
    runtime.reveal(annotation);
  };

  return h(
    'div',
    {
      className: 'anno-row',
      role: 'button',
      tabIndex: 0,
      onClick: jump,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          jump();
        }
      },
    },
    h('span', { className: 'anno-num', title: t('panel.jump') }, String(number)),
    h(
      'div',
      { className: 'anno-row-main' },
      h('div', { className: 'anno-row-quote' }, quote === '' ? t('panel.noNote') : quote),
      note === '' ? null : h('div', { className: 'anno-row-note' }, note),
      h('div', { className: 'anno-row-meta' }, sourceLabel),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'anno-icon-btn anno-row-action',
        title: t('panel.jump'),
        'aria-label': t('panel.jump'),
        onClick: (event) => {
          event.stopPropagation();
          jump();
        },
      },
      h(AnnoIcon, { name: 'jump', size: 14 }),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'anno-icon-btn anno-row-action',
        title: t('panel.delete'),
        'aria-label': t('panel.delete'),
        onClick: (event) => {
          event.stopPropagation();
          runtime.removeAnnotation(annotation.id);
        },
      },
      h(AnnoIcon, { name: 'trash', size: 14 }),
    ),
  );
}

/**
 * Right-sidebar tab body: the annotation list docks where documents dock, so
 * reviewing annotations never covers the conversation.
 */
function AnnoSidebarBody(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  annoUseRuntime(runtime);
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    runtime.pruneDeletedSessions();
  }, [runtime]);
  const state = runtime.state;
  const visible = annoVisibleAnnotations(runtime.store.list(), { sessionId: state.currentSessionId });
  const counts = runtime.cleanupCounts();
  const openKeys = new Set(state.openDocs.map((entry) => entry.docKey));
  const openPaths = new Set(state.openDocs.map((entry) => entry.path).filter(Boolean));
  const isOpen = (annotation) =>
    (typeof annotation.docKey === 'string' && openKeys.has(annotation.docKey)) ||
    (typeof annotation.path === 'string' && annotation.path !== '' && openPaths.has(annotation.path));
  const openDocs = visible.documents.filter(isOpen);
  const otherDocs = visible.documents.filter((annotation) => !isOpen(annotation));
  const otherGroups = annoGroupDocuments(otherDocs);
  const total = visible.count;

  const saveLabel = (annotation) => {
    if (annotation.source === 'chat') return t('panel.chatSource');
    const path = typeof annotation.path === 'string' ? annotation.path : '';
    const name = path.split(/[\\/]/).filter(Boolean).pop();
    return name || t('panel.unknownPath');
  };

  const row = (annotation) =>
    h(AnnoSidebarRow, {
      key: annotation.id,
      t: t,
      runtime: runtime,
      annotation: annotation,
      number: visible.numbers.get(annotation.id) || 0,
      sourceLabel: saveLabel(annotation),
    });

  return h(
    'div',
    { className: 'anno-side', 'data-dsh-anno-ui': '' },
    h(
      'div',
      { className: 'anno-side-head' },
      h('span', { className: 'anno-side-title' }, t('panel.title')),
      h('span', { className: 'anno-side-count' }, total === 0 ? t('panel.count.empty') : t('panel.count', { n: total })),
      h(
        'span',
        { className: 'anno-side-menu-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'anno-side-clean',
            title: t('side.cleanHint'),
            'aria-expanded': menuOpen ? 'true' : 'false',
            onClick: () => setMenuOpen((value) => !value),
          },
          t('side.clean'),
        ),
        menuOpen
          ? h(
              'div',
              { className: 'anno-clean-menu', role: 'menu' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'anno-clean-item',
                  disabled: counts.sent === 0,
                  onClick: () => {
                    runtime.cleanupAnnotations('sent');
                    setMenuOpen(false);
                  },
                },
                h('span', null, t('side.cleanSent')),
                h('span', { className: 'anno-clean-count' }, String(counts.sent)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'anno-clean-item',
                  disabled: counts.others === 0,
                  onClick: () => {
                    runtime.cleanupAnnotations('others');
                    setMenuOpen(false);
                  },
                },
                h('span', null, t('side.cleanOthers')),
                h('span', { className: 'anno-clean-count' }, String(counts.others)),
              ),
              h('div', { className: 'anno-clean-hint' }, t('side.cleanHint')),
            )
          : null,
      ),
    ),
    h(
      'div',
      { className: 'anno-side-body' },
      total === 0 ? h('div', { className: 'anno-panel-empty' }, t('panel.empty')) : null,
      visible.chat.length === 0
        ? null
        : h(
            'div',
            { className: 'anno-section' },
            h('div', { className: 'anno-section-title' }, t('panel.section.chat')),
            visible.chat.map(row),
          ),
      openDocs.length === 0
        ? null
        : h(
            'div',
            { className: 'anno-section' },
            h('div', { className: 'anno-section-title' }, t('panel.section.docs')),
            openDocs.map(row),
          ),
      otherGroups.length === 0
        ? null
        : h(
            'div',
            { className: 'anno-section' },
            h('div', { className: 'anno-section-title' }, t('panel.section.other')),
            otherGroups.map((group) =>
              h(
                'div',
                { key: group.docKey + '|' + (group.path || ''), className: 'anno-group' },
                h(
                  'div',
                  { className: 'anno-group-title', title: group.path || '' },
                  (group.path || t('panel.unknownPath')).split(/[\\/]/).filter(Boolean).pop() ||
                    t('panel.unknownPath'),
                ),
                group.annotations.map((annotation) =>
                  h(AnnoSidebarRow, {
                    key: annotation.id,
                    t: t,
                    runtime: runtime,
                    annotation: annotation,
                    number: visible.numbers.get(annotation.id) || 0,
                    sourceLabel: saveLabel(annotation),
                  }),
                ),
              ),
            ),
          ),
    ),
  );
}

/** Transient toast for copy/open/missing feedback. */
function AnnoNotice(props) {
  const t = annoTranslate(props);
  const notice = props.notice;
  const map = {
    openFailed: t('panel.openFailed'),
    missing: t('panel.jumpMissing'),
    none: t('send.none'),
    unavailable: t('send.unavailable'),
    sending: t('send.sending'),
    sent: t('send.sent'),
    failed: t('send.failed'),
    tabFailed: t('side.failed'),
    cleaned: t('side.cleaned'),
    copied: t('copy.done'),
  };
  const text = map[notice] || '';
  if (text === '') return null;
  return h(
    'div',
    { className: 'anno-notice', role: 'status', 'data-dsh-anno-ui': '' },
    text,
  );
}

/** Small dot marker sitting beside each highlighted passage. */
function AnnoPins(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  annoUseRuntime(runtime);
  const pins = runtime.state.pins || [];
  if (pins.length === 0) return null;
  return h(
    React.Fragment,
    null,
    pins.map((pin) =>
      h('button', {
        key: pin.id,
        type: 'button',
        className: 'anno-pin anno-pin-' + pin.color + (pin.sent ? ' is-sent' : ''),
        style: { left: pin.left + 'px', top: pin.top + 'px' },
        title: pin.note !== '' ? pin.note : pin.quote || t('panel.noNote'),
        'aria-label': t('pin.edit'),
        'data-dsh-anno-ui': '',
        onPointerDown: (event) => event.preventDefault(),
        onClick: () => runtime.openEditor(pin.id, null),
      }, String(pin.number)),
    ),
  );
}

/**
 * One aggregated chip inside the composer card: how many annotations are
 * waiting, a send action, and an expandable list of their quotes and notes.
 */
function AnnoPendingCard(props) {
  const t = annoTranslate(props);
  const runtime = props.runtime;
  annoUseRuntime(runtime);
  const [open, setOpen] = React.useState(false);
  const inputActions = props.inputActions;
  const useInput = typeof props.useInput === 'function' ? props.useInput : null;
  const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : null;
  const draft = useInput ? useInput((state) => (state && typeof state.draft === 'string' ? state.draft : '')) : '';
  const status = useSessionStatus
    ? useSessionStatus((map) => (map && props.sessionId ? map[props.sessionId] : null))
    : null;
  const draftRef = React.useRef(draft);
  const statusRef = React.useRef(status);
  const sendingRef = React.useRef(false);
  draftRef.current = draft;
  statusRef.current = status;

  // The composer's send button belongs to the host. When the composer already
  // has text and annotations are pending, a plain click would send only the
  // text. Intercept that one gesture and submit the combined message instead,
  // preserving attachments because the host still performs the submit.
  React.useEffect(() => {
    if (!inputActions || typeof inputActions.setDraft !== 'function' || typeof inputActions.submit !== 'function') return undefined;
    const onClick = (event) => {
      if (sendingRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-dsh-anno-ui]') !== null) return;
      const button = target.closest('button');
      if (button === null || button.closest('[data-composer-card]') === null) return;
      const className = typeof button.className === 'string' ? button.className : '';
      if (!/(?:^|\s)\S*_primary(?:\s|$)/.test(className)) return;
      if (button.disabled) return;
      const state = statusRef.current;
      // Running/blocked primary is stop/steer/queue; leave it to the host.
      if (state && (state.running || state.pendingInteraction)) return;
      const current = typeof draftRef.current === 'string' ? draftRef.current : '';
      if (current.trim() === '' || current.trimStart().startsWith('/')) return;
      const pendingNow = runtime.pendingAnnotations();
      if (pendingNow.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const prompt = annoBuildAgentPrompt(pendingNow, { zh: annoIsChineseLocale(runtime) });
      const combined = current.replace(/\s+$/, '') + '\n\n' + prompt;
      const ids = pendingNow.map((item) => item.id);
      sendingRef.current = true;
      try {
        inputActions.setDraft(combined);
      } catch {
        sendingRef.current = false;
        runtime.setNotice('failed');
        return;
      }
      window.setTimeout(() => {
        try {
          inputActions.submit();
          runtime.store.markSent(ids);
          runtime.repaint();
          runtime.setNotice('sent');
        } catch {
          runtime.setNotice('failed');
        } finally {
          sendingRef.current = false;
        }
      }, 80);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [inputActions, runtime]);

  const pending = runtime.pendingAnnotations();
  if (pending.length === 0) return null;
  const numbers = annoVisibleAnnotations(runtime.store.list(), {
    sessionId: runtime.state.currentSessionId,
  }).numbers;

  const jump = (annotation) => {
    if (annotation.source === 'document') {
      const isOpen = runtime.state.openDocs.some(
        (entry) =>
          entry.docKey === annotation.docKey ||
          (typeof annotation.path === 'string' && annotation.path !== '' && entry.path === annotation.path),
      );
      if (!isOpen) {
        Promise.resolve(runtime.openDocument(annotation.docKey)).then((opened) => {
          if (!opened) {
            runtime.setNotice('openFailed');
            return;
          }
          window.setTimeout(() => runtime.reveal(annotation), 900);
        });
        return;
      }
    }
    runtime.reveal(annotation);
  };

  return h(
    'div',
    {
      className: 'anno-pending',
      'data-dsh-anno-ui': '',
      onKeyDown: (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          runtime.sendPendingAnnotations();
        }
      },
    },
    h(
      'div',
      { className: 'anno-pending-head' },
      h(
        'button',
        {
          type: 'button',
          className: 'anno-pending-toggle',
          'aria-expanded': open ? 'true' : 'false',
          title: t('pending.title'),
          onClick: () => setOpen((value) => !value),
        },
        h(AnnoIcon, { name: 'note', size: 14 }),
        h('span', { className: 'anno-pending-label' }, t('pending.count', { n: pending.length })),
        h(AnnoIcon, { name: open ? 'chevron-down' : 'chevron-up', size: 13 }),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'anno-pending-send',
          title: t('pending.send'),
          onClick: () => runtime.sendPendingAnnotations(),
        },
        t('pending.send'),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'anno-pending-body' },
          pending.map((annotation) =>
            h(
              'div',
              { key: annotation.id, className: 'anno-pending-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'anno-pending-item',
                  onClick: () => jump(annotation),
                },
                h('span', { className: 'anno-pending-num' }, String(numbers.get(annotation.id) || 0)),
                h(
                  'span',
                  { className: 'anno-pending-text' },
                  h('span', { className: 'anno-pending-quote' }, annoQuotePreview(annotation, 92)),
                  typeof annotation.note === 'string' && annotation.note.trim() !== ''
                    ? h('span', { className: 'anno-pending-note' }, annotation.note.trim())
                    : null,
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'anno-icon-btn',
                  title: t('panel.delete'),
                  'aria-label': t('panel.delete'),
                  onClick: () => runtime.removeAnnotation(annotation.id),
                },
                h(AnnoIcon, { name: 'trash', size: 13 }),
              ),
            ),
          ),
          h('div', { className: 'anno-pending-hint' }, t('pending.hint')),
        )
      : null,
  );
}

/** Root overlay entry: pins, toolbar, editor, send bar, panel and toast. */
function AnnoOverlay(props) {
  const runtime = props.runtime;
  const t = annoTranslate(props);
  annoUseRuntime(runtime);
  const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null;
  const sessionId = useSessions
    ? useSessions((snapshot) => {
        if (!snapshot || !snapshot.byId) return null;
        for (const item of Object.values(snapshot.byId)) {
          if (item && item.retainedBy && (item.retainedBy.mainView || 0) > 0) return item.id || null;
        }
        return null;
      })
    : null;

  React.useEffect(() => {
    if (typeof sessionId === 'string' && sessionId !== '') runtime.setCurrentSession(sessionId);
  }, [sessionId, runtime]);

  const state = runtime.state;
  return h(
    React.Fragment,
    null,
    h(AnnoPins, { t: t, runtime: runtime }),
    state.toolbar === null
      ? null
      : h(AnnoToolbar, { t: t, runtime: runtime, payload: state.toolbar }),
    state.editor === null
      ? null
      : h(AnnoEditor, { key: state.editor.id, t: t, runtime: runtime, editor: state.editor }),
    state.notice === null ? null : h(AnnoNotice, { t: t, notice: state.notice }),
  );
}

/** Sidebar-foot trigger that opens the annotations tab in the right sidebar. */
function AnnoFooterButton(props) {
  const runtime = props.runtime;
  const t = annoTranslate(props);
  const wide = props.wide !== false;
  annoUseRuntime(runtime);
  const count = annoVisibleAnnotations(runtime.store.list(), {
    sessionId: runtime.state.currentSessionId,
  }).count;

  return h(
    'button',
    {
      type: 'button',
      className: 'anno-footer-btn' + (wide ? '' : ' is-rail'),
      title: t('footer.hint'),
      'aria-label': t('footer.title'),
      'data-dsh-anno-ui': '',
      onClick: (event) => {
        event.stopPropagation();
        if (!runtime.openAnnotationsTab()) runtime.setNotice('tabFailed');
      },
    },
    h(AnnoIcon, { name: 'highlighter', size: 18 }),
    wide ? h('span', { className: 'anno-footer-label' }, t('footer.title')) : null,
    count > 0
      ? h('span', { className: 'anno-footer-count' }, count > 99 ? '99+' : String(count))
      : null,
  );
}

/**
 * Optional compatibility stylesheet (default off): hides another sidebar
 * plugin's own "add to conversation" selection button so it cannot cover the
 * annotation toolbar. Operators opt in explicitly; see the debug handle.
 */
function annoCompatCss() {
  if (typeof annoHideForeignPopupEnabled !== 'function' || !annoHideForeignPopupEnabled()) return '';
  return [
    'button[class*="selectionPopup"]{display:none !important;}',
    'button[class*="selection-popup"]{display:none !important;}',
  ].join('\n');
}

/** Stylesheet owned by the plugin; injected once and removed on unload. */
function annoPluginCss() {
  return [
    '::highlight(dsh-anno-yellow){background-color:rgba(250,204,21,0.36);}',
    '::highlight(dsh-anno-green){background-color:rgba(52,199,89,0.30);}',
    '::highlight(dsh-anno-blue){background-color:rgba(59,130,246,0.28);}',
    '::highlight(dsh-anno-pink){background-color:rgba(244,63,94,0.26);}',
    '::highlight(dsh-anno-flash){background-color:rgba(37,99,235,0.46);}',
    '.anno-toolbar{position:fixed;pointer-events:auto;z-index:1200;display:flex;align-items:center;gap:8px;box-sizing:border-box;padding:6px 9px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 10px 28px rgba(0,0,0,0.20);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;user-select:none;}',
    '.anno-composer{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:10px;width:344px;}',
    '.anno-composer-input{display:block;box-sizing:border-box;width:100%;min-height:56px;max-height:150px;resize:vertical;padding:8px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;outline:none;}',
    '.anno-composer-input:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.anno-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
    '.anno-check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;}',
    '.anno-check:hover{background:var(--dsw-alias-button-info-hover);}',
    '.anno-composer-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;}',
    '.anno-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
    '.anno-icon-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);color:var(--dsw-alias-label-primary);}',
    '.anno-editor{position:relative;pointer-events:auto;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100vh - 80px);padding:12px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 18px 44px rgba(0,0,0,0.28);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;}',
    '.anno-editor-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}',
    '.anno-editor-title{font-weight:600;}',
    '.anno-editor-saved{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;}',
    '.anno-editor-note{display:block;box-sizing:border-box;width:100%;min-height:96px;max-height:240px;resize:vertical;padding:8px 10px;font-size:13px;padding:7px 9px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.5;outline:none;}',
    '.anno-editor-note:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.anno-editor-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;}',
    '.anno-editor-hint{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;}',
    '.anno-text-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;}',
    '.anno-text-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
    '.anno-text-btn:disabled{opacity:0.45;cursor:default;}',
    '.anno-text-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:transparent;}',
    '.anno-text-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
    '.anno-panel{position:fixed;pointer-events:auto;z-index:1190;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;box-sizing:border-box;border-radius:14px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 16px 40px rgba(0,0,0,0.24);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;overflow:hidden;}',
    '.anno-panel-header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none;}',
    '.anno-panel-title{font-weight:600;}',
    '.anno-panel-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
    '.anno-panel-body{flex:1;min-height:0;overflow-y:auto;padding:6px 8px 10px;}',
    '.anno-panel-empty{padding:22px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;text-align:center;}',
    '.anno-section{margin-top:6px;}',
    '.anno-section-title{padding:6px 6px 4px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:0.02em;text-transform:none;}',
    '.anno-group{margin-top:4px;}',
    '.anno-group-title{padding:4px 6px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.anno-row{display:flex;align-items:flex-start;gap:8px;padding:7px 6px;border-radius:8px;cursor:pointer;}',
    '.anno-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);}',
    '.anno-row-main{flex:1;min-width:0;}',
    '.anno-row-quote{font-size:12px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
    '.anno-row-note{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
    '.anno-row-meta{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:10.5px;opacity:0.85;}',
    '.anno-row-action{flex:none;opacity:0;}',
    '.anno-row:hover .anno-row-action,.anno-row:focus-within .anno-row-action{opacity:1;}',
    '.anno-pin{position:fixed;z-index:1185;transform:translateY(-50%);min-width:17px;height:17px;padding:0 4px;border-radius:999px;border:1px solid var(--dsw-alias-bg-overlay);background:var(--dsw-alias-state-warn-primary);color:#fff;font-family:inherit;font-size:10px;line-height:15px;font-weight:600;text-align:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.25);}',
    '.anno-pin:hover{transform:translateY(-50%) scale(1.15);}',
    '.anno-pin.is-sent{opacity:0.35;}',
    '.anno-pin-yellow{background:var(--dsw-alias-state-warn-primary);}',
    '.anno-pin-green{background:var(--dsw-alias-state-success-primary);}',
    '.anno-pin-blue{background:var(--dsw-alias-brand-primary);}',
    '.anno-pin-pink{background:var(--dsw-alias-state-error-primary);}',
    '.anno-side{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;padding:10px 12px 14px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;overflow:hidden;}',
    '.anno-side-head{display:flex;align-items:center;gap:8px;flex:none;padding-bottom:8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);}',
    '.anno-side-title{font-weight:600;}',
    '.anno-side-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
    '.anno-side-menu-wrap{position:relative;flex:none;}',
    '.anno-side-clean{padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:18px;cursor:pointer;}',
    '.anno-side-clean:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary);}',
    '.anno-clean-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;display:flex;flex-direction:column;width:210px;box-sizing:border-box;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 10px 24px rgba(0,0,0,0.2);}',
    '.anno-clean-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;text-align:left;cursor:pointer;}',
    '.anno-clean-item:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
    '.anno-clean-item:disabled{opacity:0.4;cursor:default;}',
    '.anno-clean-count{min-width:18px;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;text-align:center;}',
    '.anno-clean-hint{padding:6px 8px 4px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45;}',
    '.anno-side-body{flex:1;min-height:0;overflow-y:auto;padding-top:4px;}',
    '.anno-num{flex:none;min-width:17px;height:17px;margin-top:1px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:17px;font-weight:600;text-align:center;}',
    '.anno-pending{position:absolute;left:0;bottom:100%;margin-bottom:12px;z-index:30;pointer-events:auto;display:flex;flex-direction:column;box-sizing:border-box;width:min(400px,100%);padding:4px;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 10px 26px rgba(0,0,0,0.18);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;}',
    '.anno-pending-head{display:flex;align-items:center;gap:6px;}',
    '.anno-pending-toggle{flex:1;display:flex;align-items:center;gap:7px;min-width:0;padding:4px 6px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;text-align:left;cursor:pointer;}',
    '.anno-pending-toggle:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
    '.anno-pending-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.anno-pending-send{flex:none;padding:4px 8px;border:none;border-radius:8px;background:var(--dsw-alias-button-info-fill);color:#fff;font-family:inherit;font-size:11px;cursor:pointer;}',
    '.anno-pending-send:hover{background:var(--dsw-alias-button-info-hover);}',
    '.anno-pending-body{margin-top:2px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:2px;max-height:220px;overflow-y:auto;}',
    '.anno-pending-row{display:flex;align-items:center;gap:4px;border-radius:8px;}',
    '.anno-pending-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);}',
    '.anno-pending-item{flex:1;min-width:0;display:flex;align-items:flex-start;gap:7px;padding:5px 6px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;text-align:left;cursor:pointer;}',
    '.anno-pending-num{flex:none;min-width:16px;height:16px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:16px;text-align:center;}',
    '.anno-pending-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}',
    '.anno-pending-quote{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.4;}',
    '.anno-pending-note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
    '.anno-pending-hint{padding:4px 6px 2px;color:var(--dsw-alias-label-secondary);font-size:10.5px;}',
    '.anno-notice{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1220;padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 8px 22px rgba(0,0,0,0.18);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;pointer-events:none;}',
    '.anno-footer-btn{display:flex;pointer-events:auto;align-items:center;justify-content:flex-start;gap:8px;box-sizing:border-box;flex:0 1 auto;min-width:0;max-width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;text-align:left;cursor:pointer;overflow:hidden;}',
    '.anno-footer-btn:hover,.anno-footer-btn.is-open{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary);}',
    '.anno-footer-btn.is-rail{width:36px;height:36px;justify-content:center;padding:0;}',
    '.anno-footer-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.anno-footer-count{flex:none;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);color:var(--dsw-alias-brand-primary);font-size:10.5px;line-height:16px;text-align:center;}',
  ].join('\n');
}
