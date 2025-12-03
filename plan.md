# Bureau IDE - Feature Implementation Plan

## Completed

### Terminal Tabs ✓
- **TERMINAL** - Interactive PTY bash terminal (node-pty)
- **OUTPUT** - Claude's bash command output (read-only)
- **PROBLEMS** - Error console with aggregation
- Server: `pty:spawn`, `pty:input`, `pty:resize`, `pty:kill` handlers
- Multi-terminal support via PTY manager

---

## Priority 1: Quick Wins ✓ (COMPLETE)

### 1. File Tab Close Button ✓
- [x] X button on each tab closes file
- [x] Clears editor (single file mode)
- [x] Unsaved changes: shows confirm dialog before closing
- **Implementation**: Editor.tsx accepts `onClose` prop, handleClose checks `isDirty`

### 2. Git Branch in Footer ✓
- [x] Footer shows actual branch from `git:status` response
- [x] Layout.tsx subscribes to WebSocket git:status messages
- **Implementation**: Layout.tsx fetches git:status on connect, stores branch in state

### 3. Terminal Maximize/Close ✓
- [x] Maximize button: toggles between default height (30%) and expanded (60%)
- [x] Close button: collapses terminal panel
- [x] Icon switches between Maximize2/Minimize2 based on state
- **Implementation**: Terminal.tsx accepts `isMaximized`, `onMaximize`, `onClose` props; Layout uses Panel refs

### 4. Chat Panel Close ✓
- [x] X button closes chat panel
- [x] Wired via Layout cloneElement to pass `onClose` prop
- **Implementation**: Chat.tsx accepts `onClose` prop, Layout passes `toggleChat`

---

## Priority 2: Medium Features (5-6)

### 5. Settings Modal (new: SettingsModal.tsx)
- [ ] Settings icon in sidebar activity bar opens modal
- [ ] Settings needed:
  - PROJECT_ROOT path (display only, requires server restart to change)
  - Theme toggle (dark only for now, prep for light)
  - Editor font size (store in localStorage, apply to Monaco)
  - Terminal font size (apply to xterm)
- [ ] Store settings in localStorage
- [ ] Create settings store (Zustand or context)
- [ ] Apply settings on load
- **New files**:
  - `src/components/SettingsModal.tsx`
  - `src/stores/settingsStore.ts` (optional, could use context)

### 6. Command Palette (new: CommandPalette.tsx)
- [ ] Cmd/Ctrl+P opens palette (or click search bar in header)
- [ ] Fuzzy search all files in project
- [ ] Use file tree data already loaded (need to flatten tree)
- [ ] Filter as user types
- [ ] Enter/click opens file in editor
- [ ] Escape closes palette
- [ ] Style: centered modal, dark bg, similar to VSCode
- [ ] Consider: use cmdk library or build simple version
- **New files**:
  - `src/components/CommandPalette.tsx`
- **Dependencies**: possibly `cmdk` or `fuse.js` for fuzzy search

---

## Priority 3: Header Menu Items

### File Menu
- [ ] New File (create empty untitled buffer)
- [ ] Open File (command palette with file filter)
- [ ] Save (Ctrl+S) - already works in editor
- [ ] Save All
- [ ] Close File

### Edit Menu
- [ ] Undo/Redo (Monaco handles, just trigger)
- [ ] Cut/Copy/Paste (browser handles)
- [ ] Find (Ctrl+F) - Monaco built-in
- [ ] Find and Replace

### View Menu
- [ ] Toggle Sidebar (wired)
- [ ] Toggle Chat Panel (wired)
- [ ] Toggle Terminal
- [ ] Zoom In/Out (editor font size)

### Go Menu
- [ ] Go to File (Ctrl+P) - Command Palette
- [ ] Go to Line (Ctrl+G)
- [ ] Go to Symbol

### Run Menu
- [ ] Run Build (`pnpm build`)
- [ ] Run Tests (`pnpm test`)
- [ ] Run Custom Command

### Terminal Menu
- [ ] New Terminal (wired via + bash button)
- [ ] Clear Terminal (wired)
- [ ] Kill Terminal

### Help Menu
- [ ] Documentation link
- [ ] About modal

---

## Priority 4: Sidebar Features

### Search Tab
- [ ] Full-text search across project (ripgrep on server?)
- [ ] Regex support
- [ ] File pattern filters
- [ ] Replace functionality
- **Server work**: Add search endpoint using grep/ripgrep

### Extensions Tab
- [ ] Future: Plugin system
- [ ] For now: List of "installed" features / about info

---

## Priority 5: Editor Enhancements

### Multi-File Tabs ✓
- [x] Track multiple open files: `{ path, content, isDirty }[]`
- [x] Tab bar with all open files
- [x] Switch between files by clicking tab
- [x] Show dirty indicator on tabs
- [x] Editor store in App.tsx (openFiles state)
- [x] Session persistence of open tabs

### Claude File Tool Integration ✓
- [x] Auto-open files when Claude uses Read/Edit/Write tools
- [x] Switch to existing tab if file already open
- [x] File watcher broadcasts Claude's edits to update editor content
- [x] External change warning when file modified while dirty
- **Implementation**: App.tsx `useWebSocketMessages` waits for `tool_result` (not `tool_use`) to ensure file is written before opening
- **Tested**: Dec 2025 - working!

### Git Diff Highlighting in Editor ✓
- [x] Show git diff decorations in Monaco gutter (green=added, red=deleted, blue=modified)
- [x] Server endpoint: `git:linediff` returns diff for a file vs HEAD
- [x] On file open/change, fetch diff and apply decorations
- [x] Use Monaco's `deltaDecorations` API for line markers
- [ ] Consider: full diff editor mode for reviewing changes
- **Why**: When Claude edits files, user needs to see what changed at a glance
- **Tested**: Dec 2025

### Other Editor Features
- [ ] Split view (horizontal/vertical)
- [ ] Minimap toggle
- [x] Breadcrumbs (file path) - already implemented in Editor.tsx

---

## Priority 6: Notifications

- [ ] Bell icon in header shows notification panel
- [ ] Toast notifications for:
  - File saved
  - Build complete/failed
  - Claude errors
  - Git operations
- [ ] Use a toast library or build simple system

---

## Implementation Order

**Phase 1 - Quick Wins:** ✓ COMPLETE
1. ~~Git branch in footer~~
2. ~~Chat panel X button~~
3. ~~Terminal maximize/close~~
4. ~~File tab close (basic, single file)~~

**Phase 2 - Multi-File Support:** ✓ COMPLETE
5. ~~Editor store for multiple files~~
6. ~~Multi-file tabs~~
7. ~~Session persistence of tabs~~
8. ~~Claude file tool integration (auto-open files)~~

**Phase 3 - Core Features:** (next)
9. Settings modal
10. Command palette

**Phase 4 - Polish:**
11. Header menus with dropdowns
12. Search functionality
13. Notifications

---

## Server Additions Needed

### Already Done:
- PTY terminal WebSocket handlers
- File operations (read, write, list)
- Git operations (status, stage, unstage, commit)
- Claude process management

### Future:
- [ ] Search endpoint (grep/ripgrep integration)
- [ ] File create endpoint
- [ ] File delete endpoint
- [ ] File rename endpoint
- [ ] Settings persistence endpoint (or just use localStorage)

---

## Architecture Notes

### State Management
Currently using:
- WebSocketContext for connection state and messaging
- Local component state for most UI

Consider adding:
- Editor store (multi-file state)
- Terminal store (multiple terminals state)
- Settings store (user preferences)
- UI store (panel visibility, sizes)

### File Structure
```
src/
├── components/
│   ├── Chat.tsx
│   ├── CommandPalette.tsx (new)
│   ├── Editor.tsx
│   ├── FileTree.tsx
│   ├── GitStatus.tsx
│   ├── Header.tsx
│   ├── Layout.tsx
│   ├── SettingsModal.tsx (new)
│   ├── Sidebar.tsx
│   └── Terminal.tsx
├── contexts/
│   └── WebSocketContext.tsx
├── stores/ (new)
│   ├── editorStore.ts
│   ├── settingsStore.ts
│   └── uiStore.ts
└── lib/
    └── cn.ts
```
