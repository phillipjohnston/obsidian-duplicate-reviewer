import { ItemView, WorkspaceLeaf, Menu, TFile, setIcon } from "obsidian";
import type DuplicateReviewerPlugin from "src/main";
import { DuplicateGroup } from "src/types";

export const DUPLICATE_REVIEW_VIEW_TYPE = "duplicate-review-view";

const COLLAPSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

export class DuplicateReviewView extends ItemView {
    private plugin: DuplicateReviewerPlugin;
    private groups: DuplicateGroup[] = [];
    private expandedGroups: Set<string> = new Set();
    private currentGroupIndex: number = 0;
    private scanInProgress: boolean = false;
    private currentFolder: string = "";

    constructor(leaf: WorkspaceLeaf, plugin: DuplicateReviewerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    public getViewType(): string {
        return DUPLICATE_REVIEW_VIEW_TYPE;
    }

    public getDisplayText(): string {
        return "Duplicate Review";
    }

    public getIcon(): string {
        return "files";
    }

    public onHeaderMenu(menu: Menu): void {
        menu.addItem((item) => {
            item.setTitle("Close")
                .setIcon("cross")
                .onClick(() => {
                    this.app.workspace.detachLeavesOfType(DUPLICATE_REVIEW_VIEW_TYPE);
                });
        });
    }

    /**
     * Set the duplicate groups to display.
     */
    public setGroups(groups: DuplicateGroup[], folderPath: string): void {
        this.groups = groups;
        this.currentFolder = folderPath;
        this.currentGroupIndex = 0;
        this.scanInProgress = false;
        this.redraw();
    }

    /**
     * Show scanning progress.
     */
    public showScanning(folderPath: string): void {
        this.scanInProgress = true;
        this.currentFolder = folderPath;
        this.groups = [];
        this.redraw();
    }

    /**
     * Redraw the view.
     */
    public redraw(): void {
        const contentEl = this.containerEl.children[1];
        contentEl.empty();

        const rootEl = contentEl.createDiv("duplicate-review-root");

        // Header
        const headerEl = rootEl.createDiv("duplicate-review-header");
        headerEl.createEl("h4", { text: "Duplicate Review" });

        if (this.currentFolder) {
            headerEl.createEl("div", {
                cls: "duplicate-review-folder",
                text: `Folder: ${this.currentFolder || "Entire vault"}`,
            });
        }

        // Show scanning state
        if (this.scanInProgress) {
            const scanningEl = rootEl.createDiv("duplicate-review-scanning");
            scanningEl.createEl("div", {
                cls: "duplicate-review-scanning-text",
                text: "Scanning for duplicates...",
            });
            return;
        }

        // No results
        if (this.groups.length === 0) {
            const emptyEl = rootEl.createDiv("duplicate-review-empty");
            emptyEl.createEl("div", {
                cls: "duplicate-review-empty-text",
                text: "No duplicates found.",
            });
            emptyEl.createEl("div", {
                cls: "duplicate-review-empty-hint",
                text: "Use the command palette or right-click a folder to scan for duplicates.",
            });
            return;
        }

        // Summary
        const summaryEl = rootEl.createDiv("duplicate-review-summary");
        const totalFiles = this.groups.reduce((sum, g) => sum + g.files.length, 0);
        summaryEl.createEl("div", {
            text: `Found ${this.groups.length} groups with ${totalFiles} files`,
        });

        // Progress
        const resolvedCount = this.groups.filter(
            (g) => g.files.length <= 1
        ).length;
        if (resolvedCount > 0) {
            summaryEl.createEl("div", {
                cls: "duplicate-review-progress",
                text: `${resolvedCount} resolved`,
            });
        }

        // Groups list
        const groupsEl = rootEl.createDiv("duplicate-review-groups nav-folder mod-root");
        const childrenEl = groupsEl.createDiv("nav-folder-children");

        for (let i = 0; i < this.groups.length; i++) {
            const group = this.groups[i];
            if (group.files.length <= 1) {
                continue; // Skip resolved groups
            }
            this.renderGroup(childrenEl, group, i);
        }
    }

    private renderGroup(parentEl: HTMLElement, group: DuplicateGroup, index: number): void {
        const isExpanded = this.expandedGroups.has(group.normalizedTitle);

        const folderEl = parentEl.createDiv("nav-folder");
        const folderTitleEl = folderEl.createDiv("nav-folder-title");
        const childrenEl = folderEl.createDiv("nav-folder-children");

        // Collapse icon
        const collapseIconEl = folderTitleEl.createDiv(
            "nav-folder-collapse-indicator collapse-icon"
        );
        collapseIconEl.innerHTML = COLLAPSE_ICON;
        if (!isExpanded) {
            (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "rotate(-90deg)";
            childrenEl.style.display = "none";
        }

        // Title with file count
        const titles = Array.from(group.originalTitles).slice(0, 2).join(", ");
        const titleText = group.originalTitles.size > 2
            ? `${titles}... (${group.files.length} files)`
            : `${titles} (${group.files.length} files)`;

        folderTitleEl.createDiv("nav-folder-title-content").setText(titleText);

        // Toggle expand/collapse
        folderTitleEl.onClickEvent(() => {
            if (this.expandedGroups.has(group.normalizedTitle)) {
                this.expandedGroups.delete(group.normalizedTitle);
                (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "rotate(-90deg)";
                childrenEl.style.display = "none";
            } else {
                this.expandedGroups.add(group.normalizedTitle);
                (collapseIconEl.childNodes[0] as HTMLElement).style.transform = "";
                childrenEl.style.display = "block";
            }
        });

        // Compare All button (only if 2-3 files)
        if (group.files.length >= 2 && group.files.length <= this.plugin.settings.maxComparisonPanes) {
            const compareBtn = folderTitleEl.createDiv("duplicate-review-compare-btn");
            compareBtn.setText("Compare");
            compareBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                await this.plugin.openMultiPaneComparison(group.files);
            });
        }

        // Files in this group
        for (const file of group.files) {
            this.renderFile(childrenEl, file, !isExpanded);
        }
    }

    private renderFile(parentEl: HTMLElement, file: TFile, hidden: boolean): void {
        const navFileEl = parentEl.createDiv("nav-file");
        if (hidden) {
            navFileEl.style.display = "none";
        }

        const navFileTitle = navFileEl.createDiv("nav-file-title");
        navFileTitle.createDiv("nav-file-title-content").setText(file.basename);

        // Show path hint on hover
        navFileTitle.setAttribute("aria-label", file.path);

        // Click to open
        navFileTitle.addEventListener("click", async (e) => {
            e.preventDefault();
            await this.app.workspace.getLeaf().openFile(file);
        });

        // Right-click context menu
        navFileTitle.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            const fileMenu = new Menu();
            this.app.workspace.trigger("file-menu", fileMenu, file, "duplicate-review");
            fileMenu.showAtPosition({ x: e.pageX, y: e.pageY });
        });
    }

    /**
     * Advance to the next group.
     */
    public nextGroup(): void {
        if (this.currentGroupIndex < this.groups.length - 1) {
            this.currentGroupIndex++;
            const group = this.groups[this.currentGroupIndex];
            this.expandedGroups.add(group.normalizedTitle);
            this.redraw();
        }
    }

    /**
     * Go to the previous group.
     */
    public previousGroup(): void {
        if (this.currentGroupIndex > 0) {
            this.currentGroupIndex--;
            const group = this.groups[this.currentGroupIndex];
            this.expandedGroups.add(group.normalizedTitle);
            this.redraw();
        }
    }
}
