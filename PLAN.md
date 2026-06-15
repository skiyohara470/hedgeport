# HedgePort Roadmap

## Product Direction

HedgePort is an Electron desktop client for working with remote files and related
data sources from one application.

The current core is a two-pane file manager for SFTP, S3, and local files. New
features should preserve these boundaries:

- File-like systems use `StorageProvider`.
- Credentials and filesystem access stay in the main process.
- Renderer access goes through narrow preload APIs.
- Non-file data sources such as DynamoDB and SQL databases use a separate
  abstraction and UI instead of pretending that tables and records are files.

## Current Baseline

Implemented:

- SFTP and account-level S3 connections
- Connection persistence and connection tests
- Remote and local file browsing
- Upload, download, delete, rename, directory creation, copy, and batch actions
- Multiple selection, context menus, toolbar actions, and shortcuts
- Multiple tabs and optional local pane
- Text preview/editing with encoding selection and automatic detection
- External editor integration
- Drag-and-drop ordering of saved connections
- Settings (persisted, versioned): theme (system/light/dark), font size, display
  density, show hidden files, confirm-before-delete, and display language (ja/en)
- Light/dark theming via CSS custom-property tokens, applied across all screens
- Japanese/English UI localization, switchable without restart

Known foundations that still need work:

- Credentials are stored in a `0600` JSON file but are not encrypted.
- Large transfers currently read whole files into memory.
- Transfer progress, cancellation, retry, and resume are not implemented.
- The standalone preview window shows real files with in-preview search; diff in
  the preview window is not implemented yet.

## Prioritized Roadmap

### P0: Security And Settings Foundation

#### Settings Screen

Create a dedicated settings screen rather than adding more controls to the
connection selection screen.

Initial sections:

- Appearance
- Connection data
- Security
- Transfer behavior
- Advanced

Settings must have a versioned persisted schema and migration path. Keep
application settings separate from connection records and transient UI state.

Status: a settings modal is implemented with the Appearance and Files sections
(theme, language, font size, display density, show hidden files, confirm before
delete). The schema is versioned and persisted in `userData/settings.json`
separately from connections, with migration that corrects unknown/invalid
fields. The Connection data, Security, Transfer behavior, and Advanced sections
remain future work.

#### Theme Selection

Support:

- System
- Light
- Dark

Use CSS custom properties as design tokens. Apply theme changes to the main
window, editor/preview UI, dialogs, and future settings windows consistently.
Persist only the theme preference, not computed colors.

Status: implemented. Colors are consolidated into `--c-*` tokens with `:root`
(dark) and `:root[data-theme='light']` overrides; `system` follows
`matchMedia('(prefers-color-scheme: dark)')`. Font size and density are applied
via root `data-*` attributes (rem-based font scaling and a `--density-scale`
padding token). The standalone preview window loads and applies the same
settings.

#### Secure Credential Storage

Move SFTP passwords and AWS credentials away from plaintext JSON.

Preferred direction:

- Encrypt secrets with Electron `safeStorage`, or use the OS credential store.
- Keep non-secret connection metadata separate from encrypted secret values.
- Migrate existing plaintext records without losing connections.
- Define behavior when secure storage is unavailable.

This should be completed before connection export is treated as a general
sharing feature.

### P1: Connection Import And Export

Expose import/export from the settings screen only.

Export format:

- Versioned JSON envelope
- Exclude internal or device-specific fields: `id`, `lastLocalPath`
- Generate new IDs on import
- Clearly state whether credentials are included
- Eventually support both "configuration only" and "include credentials"

Duplicate handling:

- SFTP: treat normalized `host + port + username` as the same server/user.
  Normalize host with `trim().toLowerCase()` and username with `trim()`.
  Do not include `name`, `password`, or `rootPath` in duplicate identity.
- S3: define the final rule during implementation. The current candidate is
  `accessKeyId + region`; do not use secret keys, session tokens, or display
  names as identity.
- Show imported, skipped, and failed counts before committing changes.
- Never silently overwrite an existing connection.

Security requirements:

- Warn that credential-bearing exports are sensitive plaintext.
- Write exported files with owner-only permissions where supported.
- Validate format, version, size, and every record in the main process.
- Do not expose arbitrary file paths to the renderer.

### P1: Preview Window

Connect the standalone preview window to actual local and remote files.

Status: real file preview and Search Within Preview are implemented; Diff is not
yet done. The default Open for a file — double-click, Enter, the toolbar eye, and
the context-menu Open, in any pane (local/SFTP/S3) — all open a dedicated preview
window through one shared dispatch; directories navigate in place on the same
paths. Built-in Editor / System Default / Choose Application are explicit choices
under Open…. The main process owns a `PreviewSession` per preview window, bound
to the window's `webContents.id`, and never embeds credentials or local absolute
paths in the URL/hash/query. `openPreview(request)` validates the typed
`PreviewOpenRequest` (`shared/preview.ts`) in main and creates one BrowserWindow
per request (multiple previews can be open). `validatePreviewRequest` enforces a
local absolute path / remote canonical virtual path, rejects NUL and control
characters, validates the remote target, and derives the display name from the
validated path (the renderer-supplied name is not trusted). `preview:metadata`
and `preview:load(encoding)` only read the session bound to `event.sender`, so
the main window or another preview cannot read it; sessions are destroyed on
window close / render-process-gone, and a failed initial render load deletes the
session and destroys the window before rejecting. Reads reuse the existing
validated `readTextFile`/`readLocalText` (path/NUL/encoding auto-or-manual; the
encoding argument is also re-validated at the main boundary), but with a
preview-specific size limit injected: the Built-in Editor keeps 1 MiB
(`MAX_EDITABLE_TEXT_BYTES`) while preview allows up to 20 MiB
(`MAX_PREVIEW_TEXT_BYTES`), enforced before decode with a preview-specific
too-large message. The size cap is checked after the provider/fs reads the whole
file into memory (current readers have no streaming path), so it bounds decode,
not the read itself — noted as a known constraint.
The preview renderer receives only `PreviewMeta` (name, display path, source) for
the header and a `PreviewDocument` (meta + `TextDocument`) for the body — no
target/secret. Metadata is fetched separately from content, so the file name /
source / path stay visible even while a decode/read fails. Content is rendered as
React text nodes (never `dangerouslySetInnerHTML`); the encoding select offers
Auto/UTF-8/Shift_JIS/EUC-JP and keeps the user's choice — picking Auto stays Auto
(re-detects on reload) and the detected encoding is shown only as a supplement on
the Auto label, not by switching the selected value. A request-id guard stops a
stale load from overwriting a newer selection.

#### Search Within Preview

Status: implemented.

- Find next/previous
- Match count and current match
- Case-sensitive toggle
- Keyboard shortcuts (`Mod+F` / `Cmd+F`, `Enter`, `Shift+Enter`, `Escape`)
- Preserve selected encoding (search recomputes after an encoding reload and
  reconciles the active match)
- Avoid blocking the renderer for large text (plain single text node when there
  is no query; only segment the body when searching, with a `MAX_MATCHES` cap
  surfaced in the UI)

The search itself is a literal (non-regex) string search in a pure renderer
module (`features/preview/previewSearch.ts`), independent of Chromium's
`webContents.findInPage`; case-insensitive matching keeps indices aligned to the
original text. Browser-native find is preventDefaulted.

Future enhancement:

- Add an optional regular-expression mode with an explicit toggle.
- Show invalid-pattern errors without hiding the current file contents.
- Keep match/result limits and avoid patterns that can block the renderer.

#### Diff

Start with text files:

- Compare local vs remote
- Compare two selected files
- Side-by-side and unified views
- Added, removed, and changed line highlighting
- Ignore whitespace option
- Encoding-aware reads

Diff is read-only in the first version. Merge/edit actions should be a later
feature because conflict handling and save destinations require separate design.

### P1: Content Search (Grep)

File-name filtering already exists in each pane. Grep is a different feature:
recursive search through file contents.

MVP:

- Search from the current directory
- Query, literal/regular-expression mode, case sensitivity, and file-name
  include/exclude patterns
- Stream results as `path + line number + excerpt`
- Open a result in preview/editor at the matching line
- Cancellation, result limits, file-size limits, and binary-file exclusion
- Clear reporting for unreadable files and partial failures

Implementation notes:

- Run traversal and decoding in the main process.
- Use bounded concurrency and never load an entire directory tree into memory.
- S3 requests can be expensive; show scope and cancellation clearly.
- Do not shell out to system `grep` as the primary implementation because
  remote providers and cross-platform behavior need one contract.

### P1: Mouse Navigation

Support hardware back/forward buttons and equivalent browser navigation events
for directory history.

Status: implemented. The main window captures Windows/Linux `app-command`
(`browser-backward`/`browser-forward`, preventDefault + forward to renderer) and
macOS trackpad `swipe` (right=back, left=forward); the preview window does not.
A preload `onHistoryNavigation(listener)` exposes only the direction with an
unsubscribe. The renderer also captures auxiliary mouse buttons (DOM `button`
3/4) and preventDefaults them (and skips navigation when the mousedown target is
a text input, since focus has not moved yet at mousedown). FilerWorkspace pushes
each input onto a queue whose items pin the destination pane+tabId at enqueue
time, then applies them one-at-a-time (awaiting each) through a per-pane
imperative handle (`PaneHandle.navigate`); items for a no-longer-active tab or an
unmounted pane are dropped. Each pane shares one `navigateBack`/`navigateForward`
with its toolbar buttons. History/path/view updates commit only on a successful
list (commit-on-success): a failed read keeps the current location, history, and
view, so back/forward availability and the breadcrumb stay consistent and the
action is retryable (back/forward still work while errored). IPC↔DOM duplicates
of the same physical input are de-duped (same direction + different source within
a short window); the rejected observation is still recorded so an immediately
following same-source input is not dropped. Same-source repeats are not de-duped.
Mapping/de-dupe logic is in pure, unit-tested functions
(`main/navigationInput.ts`, `features/filer/mouseNavigation.ts`).

- Mouse Back navigates the focused pane to its previous directory.
- Mouse Forward navigates the focused pane to its next directory.
- Remote and local pane histories remain independent.
- Do nothing when the focused pane has no matching history entry.
- Prevent Electron/Chromium's default navigation so one input causes exactly one
  directory transition.
- Ignore navigation input while a modal, editor, or text field is actively
  handling input.
- Keep the existing Back/Forward toolbar buttons and use the same navigation
  functions so mouse and button behavior cannot diverge.
- Verify behavior on macOS, Windows, and Linux because auxiliary mouse buttons
  and trackpad gestures can surface through different Electron events.

### P1: Window Chrome And Native Control Integration

Make the Electron window frame and native-looking form controls feel consistent
with the selected HedgePort theme.

Window title bar:

- On macOS, use an integrated title bar such as `titleBarStyle: 'hiddenInset'`
  while retaining the native traffic-light close/minimize/zoom controls.
- Extend the application background into the title-bar area so the top strip
  does not appear as a separate light or dark block.
- Reserve a drag region with `-webkit-app-region: drag` and explicitly mark
  buttons, tabs, inputs, and other interactive elements as `no-drag`.
- Position toolbar content and traffic lights without overlap at supported
  window sizes.
- Apply the same policy to the main and preview windows.
- Keep platform-specific behavior: do not imitate macOS traffic lights on
  Windows or Linux. Use Electron title-bar overlay capabilities only where they
  preserve native window operations and accessibility.
- Verify fullscreen, maximize/restore, window dragging, double-click title-bar
  behavior, and keyboard window commands.

Form controls:

- Theme checkboxes consistently instead of relying on the OS-default floating
  appearance.
- Support unchecked, checked, disabled, focused, and `indeterminate` states.
- Use theme color tokens and scale with font-size/density settings.
- Preserve the native input element for semantics, keyboard operation, screen
  readers, and form behavior; custom styling must not replace accessibility.
- Apply the same checkbox styling to file selection, select-all, settings, and
  editor BOM controls.

### P1: Keyboard File Navigation And Selection

Make the file table usable without moving between rows with the mouse.

- Maintain a keyboard cursor (active row) separately from the selected items.
- Up/Down moves the active row instead of scrolling the file list directly.
- Keep the active row visible with the minimum required scroll adjustment.
- Space toggles selection for the active row without opening it.
- Shift+Up/Down extends or shrinks a contiguous range from the selection anchor.
- Mod+Space toggles the active row while preserving other selected rows.
- Home/End moves to the first/last visible row.
- Enter opens the active file or directory using the existing default Open
  behavior.
- The active row must have a visible theme-aware focus indicator distinct from
  the selected-row style.
- Search, sorting, directory changes, hidden-file changes, and reloads must
  reconcile the active row and selection so invisible entries cannot remain
  actionable.
- Keyboard handling applies only to the focused pane and must not run while an
  input, textarea, select, modal, or editor is handling input.
- Reuse the existing selection model and file actions rather than creating a
  second selection state with different context-menu or toolbar behavior.
- Add ARIA semantics for the active row and selected rows, and test single,
  toggle, range, boundary, filtered, and empty-list behavior.

### P1: Localization Completion

Complete Japanese and English coverage for every user-visible renderer string.

Status: implemented. ConnectionForm, FilerWorkspace/FileTable, name dialogs,
editor/preview, external-edit banner, context menus, toolbars, navigation,
status bar, and fallback errors are routed through the typed `features/i18n`
dictionary and `useTranslation`. Renderer-generated status/validation messages
are stored as structured `key + params` (or `raw` for main/server text) so they
re-translate on language change, and open forms/dialogs/editor update live.
Plural/count phrasing uses explicit per-language keys. A contract test
(`src/renderer/src/i18n.contract.test.ts`) flags newly hardcoded visible
attribute/text/dialog/sentence literals with an explicit technical-term
allowlist (SFTP, S3, UTF-8 BOM, etc.). Main/server raw error text is
intentionally left untranslated. Date formatting follows the selected language
(`ja-JP` / `en-US`), not the OS locale.

Implemented coverage:

- Connection create/edit form labels, help text, validation (submit and test),
  test results, and delete actions
- New-directory and rename dialogs
- Editor/preview controls, encoding label, fallbacks, and external-edit status
- Batch-operation results, fallback errors, context menus, tooltips, titles, and
  ARIA labels, with explicit singular/plural phrasing per language

Requirements (met):

- Do not leave user-visible strings embedded directly in React components.
- Keep translation keys typed and use one shared translator for toolbar,
  context-menu, shortcut, confirmation, and status labels.
- Preserve dynamic values such as connection names, paths, encodings, provider
  names, counts, and file-manager names.
- Define plural/count phrasing explicitly for both languages.
- Main-process/server error text may remain technical English initially, but
  renderer fallback and validation messages must be localized.
- Add a test or lint-style contract that detects newly introduced untranslated
  renderer literals, with explicit allowlists for technical terms.
- Test the connection create/edit flow and new-directory/rename flow end to end
  in both Japanese and English.

### P1: Application Icon And Launchable Distribution

Add HedgePort application branding and produce an installable/launchable desktop
build rather than only a development bundle.

- Create a single high-resolution source icon with safe margins and transparent
  background.
- Generate platform assets: macOS `.icns`, Windows `.ico`, and Linux PNG sizes.
- Use the icon for packaged applications, installers, taskbar/dock, window icon
  where supported, and development windows where practical.
- Add packaging configuration and scripts such as `package` / `dist` without
  changing the existing development and test commands.
- Define application ID, product name, executable name, artifact names, and
  version source.
- Verify a clean build can be installed or launched on macOS first; document
  unsigned-build warnings until code signing/notarization is configured.
- Keep credentials and user settings outside the packaged application so
  upgrades do not overwrite them.
- Add smoke checks that the packaged app starts, opens its main window, loads
  settings/connections, and displays the expected icon.
- Treat Windows installer and Linux package formats as follow-up deliverables
  after the macOS packaging path is stable.

### P2: Transfer Reliability

- Streaming upload/download instead of whole-file buffering
- Progress and current throughput
- Cancellation
- Bounded parallelism
- Retry policy
- Multipart upload for large S3 objects
- Resume support where the provider permits it
- Transfer queue/history

These changes are prerequisites for treating HedgePort as a reliable large-file
transfer client.

### P2: Database And DynamoDB Support

Database support fits HedgePort if the product is intentionally broadened from
"file transfer client" to "connection workspace." It should not be implemented
as another `StorageProvider`.

Introduce a separate abstraction, for example:

```ts
interface DataSourceProvider {
  listResources(): Promise<DataResource[]>
  describeResource(id: string): Promise<DataResourceSchema>
  query(request: DataQuery): Promise<DataPage>
}
```

#### Recommended First Target: DynamoDB

DynamoDB is the best first database-like integration because the application
already has AWS credentials and region concepts.

First release should be read-only:

- List tables
- Describe keys and indexes
- Query by partition/sort key
- Scan only with explicit confirmation
- Pagination via `LastEvaluatedKey`
- Item detail as structured JSON
- Copy/export selected items

Write, update, and delete operations should come later with explicit
confirmation and condition expressions to avoid accidental data loss.

#### SQL Databases

PostgreSQL/MySQL support is possible, but it is a substantially different
product surface:

- TLS and SSH tunnels
- Query editor and result grid
- Schema browsing
- Timeouts and cancellation
- Read-only mode
- Transaction handling
- Safe limits for unrestricted queries

Add SQL only after the `DataSourceProvider` boundary and DynamoDB read-only UX
have proven useful. Do not mix SQL query execution into the file panes.

### P2: Quality And Distribution

- Main/preload IPC integration tests
- End-to-end tests for critical connection and transfer flows
- Structured logging with secret redaction
- Crash/error diagnostics
- Automatic update strategy
- Code signing and notarization for distribution
- Accessibility pass, including a keyboard alternative for drag ordering

## Suggested Delivery Order

1. Settings screen and versioned settings persistence
2. Theme selection
3. Secure credential storage and migration
4. Settings-based connection import/export
5. Real preview window and in-preview search (done; diff pending)
6. Text diff
7. Recursive grep with cancellation and limits
8. Mouse back/forward directory navigation
9. Integrated window chrome and themed form controls
10. Keyboard file navigation and Space selection
11. Complete Japanese/English localization
12. Application icon and launchable macOS package
13. Streaming transfer queue and progress
14. `DataSourceProvider` design
15. Read-only DynamoDB explorer

## Definition Of Done

Every roadmap item should include:

- Main/preload/renderer responsibility boundaries
- Input validation in the main process
- Secret redaction in errors and logs
- Cancellation and resource limits for long-running operations
- Unit tests for pure logic
- IPC contract tests where APIs are added
- UI tests for success, cancellation, empty, and failure states
- `npm run typecheck`, `npm test`, and `npm run build`
