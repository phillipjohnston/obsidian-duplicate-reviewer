# Duplicate Reviewer Obsidian Plugin - Implementation Plan

## Overview
An Obsidian plugin that finds duplicate notes and allows iterative review with multi-pane comparison.

## Requirements Summary
1. Find duplicate notes based on title/content similarity
2. Review modes:
   - Pattern-based review (e.g., all "Notes", "Untitled" files)
   - Multi-up comparison (open 2-3 duplicates side-by-side)
3. Triggers:
   - Right-click folder context menu
   - Modal folder picker from command palette

## Project Structure

```
duplicate-reviewer/
├── manifest.json              # Plugin metadata
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
├── esbuild.config.mjs         # Build config
├── styles.css                 # Plugin styles
├── src/
│   ├── main.ts                # Plugin entry point
│   ├── settings.ts            # Settings tab
│   ├── types.ts               # TypeScript interfaces
│   ├── similarity/
│   │   ├── index.ts           # Exports
│   │   ├── title.ts           # Title normalization & similarity
│   │   └── content.ts         # Content similarity
│   ├── scanner/
│   │   └── index.ts           # File scanning logic
│   ├── modals/
│   │   ├── FolderSelectModal.ts
│   │   └── PatternSelectModal.ts
│   └── views/
│       └── DuplicateReviewView.ts  # Sidebar queue view
```

## Core Features

### 1. Similarity Detection (ported from organization.py)
- `normalizeTitle()` - Remove prefixes ("EAD0001", "250.25"), punctuation, lowercase
- `titleSimilarity()` - Jaccard similarity on word sets
- `contentSimilarity()` - Jaccard similarity on first 1000 chars

### 2. Context Menu Integration
```typescript
this.app.workspace.on("file-menu", (menu, fileish) => {
    if (fileish instanceof TFolder) {
        menu.addItem((item) => {
            item.setTitle("Find duplicates in folder")
                .setIcon("files")
                .onClick(() => this.startDuplicateReview(fileish));
        });
    }
});
```

### 3. Folder Selection Modal
- Extend `FuzzySuggestModal<TFolder>` for fuzzy folder search
- Filter out ignored folders (.obsidian, .git, .trash, 998 Readwise)

### 4. Sidebar Review Queue
- Extend `ItemView` for sidebar panel
- Group duplicates by normalized title
- Show file count per group
- "Compare All" button for groups with 2-3 files

### 5. Multi-Pane Comparison
```typescript
async openMultiPaneComparison(files: TFile[]): Promise<void> {
    let leaf = this.app.workspace.getLeaf();
    for (let i = 0; i < files.length; i++) {
        if (i > 0) {
            leaf = this.app.workspace.getLeaf('split', 'vertical');
        }
        await leaf.openFile(files[i]);
    }
}
```

## Settings
| Setting | Default | Description |
|---------|---------|-------------|
| Title Similarity Threshold | 80% | Minimum title similarity |
| Content Similarity Threshold | 60% | Minimum content similarity |
| Content Chars to Analyze | 1000 | Characters to compare |
| Ignored Folders | .obsidian, .git, .trash, 998 Readwise | Skip these folders |
| Common Patterns | Notes, Untitled, Note, New Note | Pattern review targets |
| Max Comparison Panes | 3 | Max side-by-side files |

## Commands
1. **Find duplicates in vault** - Opens folder select modal
2. **Find duplicates by pattern** - Opens pattern select modal
3. **Review next duplicate pair** - Advances to next pair in queue

## Implementation Phases

### Phase 1: Project Scaffolding
- [x] Create manifest.json
- [x] Create package.json with dependencies
- [x] Create tsconfig.json
- [x] Create esbuild.config.mjs
- [x] Create basic src/main.ts

### Phase 2: Similarity Logic
- [x] Implement src/types.ts
- [x] Port normalizeTitle() to src/similarity/title.ts
- [x] Port titleSimilarity()
- [x] Port contentSimilarity() to src/similarity/content.ts

### Phase 3: Scanner
- [x] Implement src/scanner/index.ts
- [x] findTitleDuplicates() - iterate files, compare pairs
- [x] refineWithContent() - add content scores
- [x] groupDuplicates() - cluster by normalized title

### Phase 4: Settings
- [x] Implement src/settings.ts with PluginSettingTab
- [x] Create all setting controls
- [x] Settings persistence

### Phase 5: Modals
- [x] FolderSelectModal (FuzzySuggestModal<TFolder>)
- [x] PatternSelectModal for pattern-based review

### Phase 6: Sidebar View
- [x] DuplicateReviewView (ItemView)
- [x] Group rendering with expand/collapse
- [x] "Compare All" buttons
- [x] Review progress tracking

### Phase 7: Integration
- [x] Register folder context menu
- [x] Register commands
- [x] Wire up multi-pane comparison

### Phase 8: Polish
- [x] Add styles.css
- [x] Error handling
- [ ] Performance testing with 40k files

## Key Files to Reference
- `../../../Meta/vault-tools/vault_tools/organization.py` - Source algorithms
- `.obsidian/plugins/obsidian-note-review/src/main.ts` - Plugin patterns
- `.obsidian/plugins/obsidian-note-review/src/sidebar.ts` - ItemView pattern

## Verification
1. Build plugin: `npm run build`
2. Enable in Obsidian settings
3. Right-click a folder → "Find duplicates in folder"
4. Verify sidebar shows grouped duplicates
5. Click "Compare All" on a 2-3 file group
6. Verify files open in split panes
7. Test pattern-based review via command palette
