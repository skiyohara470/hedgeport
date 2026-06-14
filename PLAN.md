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
- The standalone preview window is still a placeholder.

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

#### Search Within Preview

- Find next/previous
- Match count and current match
- Case-sensitive toggle
- Keyboard shortcuts (`Mod+F`, `Enter`, `Shift+Enter`, `Escape`)
- Preserve selected encoding
- Avoid blocking the renderer for large text

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
- Query, case sensitivity, and file-name include/exclude patterns
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
5. Real preview window and in-preview search
6. Text diff
7. Recursive grep with cancellation and limits
8. Mouse back/forward directory navigation
9. Integrated window chrome and themed form controls
10. Keyboard file navigation and Space selection
11. Streaming transfer queue and progress
12. `DataSourceProvider` design
13. Read-only DynamoDB explorer

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
