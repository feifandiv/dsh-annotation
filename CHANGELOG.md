# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/).

## [2.2.2] - 2026-11-08

### Added
- Sending from the composer now carries pending annotations with the typed
  message. When the composer already has text and annotations are pending, the
  host's send gesture is intercepted once: the typed text and the annotation
  batch are merged into one message, attachments included, and the annotations
  are marked sent. With an empty composer the send button is untouched.

## [2.2.1] - 2026-11-08

### Fixed
- Focusing the annotation comment box collapsed the document selection, so
  Cmd/Ctrl+C copied nothing. With no text selected inside the comment box, the
  copy shortcut (or Edit → Copy) now copies the annotated passage; selecting
  part of the note still uses the normal copy behaviour.

## [2.2.0] - 2026-11-08

### Added
- Lifecycle cleanup. Chat annotations of deleted sessions are pruned
  automatically once the client session index is stable (retries at startup and
  again whenever the list is opened); archived sessions keep their annotations
  because they can still be reopened.
- A "清理" menu in the sidebar list header: clean sent annotations and clean
  annotations from other sessions, each showing its count.
- The auto-prune waits for two identical session counts, so a partially loaded
  sidebar cannot be mistaken for deleted sessions.

## [2.1.0] - 2026-11-08

### Changed
- The annotation list now opens as a native right-sidebar tab, so reviewing
  annotations docks beside the conversation instead of covering it. The
  centered modal is gone; the sidebar-foot "标注" entry opens or focuses the tab.
- Numbers are back: pins, composer-card rows and sidebar rows share one
  creation-order numbering (1..N), so a highlighted place and its list row
  always match.
- The sidebar-foot badge counts what the list shows (active-session chat plus
  document annotations) instead of every annotation in storage, including stale
  ones from older sessions.

### Fixed
- The comment box no longer disappears while typing. Scroll and resize no
  longer dismiss it, and Enter used to commit an IME composition (Chinese
  input) no longer confirms the annotation.

## [2.0.0] - 2026-11-08

### Changed
- Simplification pass. The plugin now does one job: select text → comment → send.
- `Enter` confirms an annotation and collects it into an aggregated "N notes"
  card above the composer instead of pasting annotation text into the input.
  Clicking the card expands every quoted passage and its note. `Cmd/Ctrl+Enter`
  confirms and sends the whole pending batch to the AI in one message. The
  shortcut also works outside the comment box while no input is focused.
- One highlight color only: the color picker is gone from the comment box and
  the edit dialog. Existing colored annotations still render.
- Numbered pins became small dot markers.
- The top pending bar was removed; the composer card shows the pending count.

### Removed
- Color selection UI.
- Copy-Markdown and export-JSON actions, plus the panel footer.
- Composer fallback delivery (draft insertion + submit); sending now uses the
  scoped conversation service only and reports a clear failure when unavailable.

## [1.3.0] - 2026-11-08

### Changed
- `Enter` now puts the annotated excerpt and its note into the conversation
  input instead of only saving it, so several annotations can be collected in
  the composer, reviewed, and extended with an instruction. `Cmd/Ctrl+Enter`
  keeps sending the whole pending batch to the agent. After a successful batch
  send, the blocks this plugin added to the composer are removed so the same
  annotations cannot be sent twice.
- Removed the global Enter-to-send shortcut while reading: Enter is no longer a
  send gesture outside the annotation input.

## [1.2.1] - 2026-10-26

### Fixed
- The inline comment box no longer flashes and closes when its input steals
  focus: a selection collapse caused by focusing the input is no longer treated
  as "annotation cancelled". Real outside clicks still dismiss it.

## [1.2.0] - 2026-10-26

### Changed
- Selecting text now opens the comment input directly; choosing a color first is
  no longer required. The color defaults to the last used one (yellow initially).
- `Enter` saves and closes the annotation without sending; `Cmd/Ctrl+Enter`
  saves and sends the whole pending batch. `Shift+Enter` inserts a newline.
- The annotation manager is a centered dialog instead of an anchored popover,
  so it can no longer land at the window's top-left corner.

### Added
- Inline numbered pins next to each annotation (hover for the note, click to
  edit), with sent annotations visually dimmed.

## [1.1.0] - 2026-10-26

### Added
- Send annotations to the agent as one user message, quoting each annotated
  passage, its location (conversation reply or document path) and the note.
- Pending batch model: annotations become pending when created or edited, and are
  marked sent after a successful send.
- Primary delivery through the scoped conversation service, with a composer
  fallback (`setDraft` + `submit`) when that face is unavailable.
- Composer bridge entry in `conversation.composer.dock`.

## [1.0.6] - 2026-10-26

### Fixed
- Note input became unusable when the editor was anchored near the selection:
  the editor is now a centered modal with event shielding and automatic focus.

## [1.0.5] - 2026-10-26

### Added
- Optional compatibility switch to hide a third-party sidebar's own
  "add to conversation" selection button
  (`__dshAnnotation.hideForeignSelectionPopup(true)`).

### Changed
- On document surfaces the annotation toolbar is placed below the selection to
  avoid overlapping third-party selection actions.

## [1.0.4] - 2026-10-26

### Changed
- On-disk diagnostics became opt-in (`enableDiagnostics()`), off by default.
- Cross-session document matching now only uses absolute paths; relative paths
  stay scoped to their resource address.

## [1.0.3] - 2026-10-26

### Added
- Support for document previews rendered by third-party sidebars inside the
  host's native right-sidebar tab body (`[data-sidebar-right-tab]`), resolving
  the document identity through `ctx.sidebarRight.tabsIn()`.

### Fixed
- Selection capture retries through window-level listeners, `mouseup` fallback
  and a settled-selection fallback, so release events swallowed by the app no
  longer lose the selection.

## [1.0.2] - 2026-10-26

### Fixed
- Document anchor extraction falls back to unfiltered text and then to the raw
  selection text, instead of losing annotations hidden by visibility filters.

## [1.0.1] - 2026-10-25

### Fixed
- Initial capture/anchor path and the highlight color declarations.

## [1.0.0] - 2026-10-25

### Added
- Inline highlights and notes for assistant replies and native sidebar document
  previews (Markdown, text, code, PDF text layer).
- CSS Custom Highlight painting, quote-based re-anchoring, local persistence,
  manager panel, Markdown/JSON export, and a `sidebar.footer.action` entry.
