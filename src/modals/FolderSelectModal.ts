import { App, FuzzySuggestModal, TFolder } from "obsidian";
import { DuplicateReviewerSettings } from "src/types";

export class FolderSelectModal extends FuzzySuggestModal<TFolder> {
    private settings: DuplicateReviewerSettings;
    private onChoose: (folder: TFolder) => void;

    constructor(
        app: App,
        settings: DuplicateReviewerSettings,
        onChoose: (folder: TFolder) => void
    ) {
        super(app);
        this.settings = settings;
        this.onChoose = onChoose;
        this.setPlaceholder("Select a folder to scan for duplicates...");
    }

    getItems(): TFolder[] {
        const folders: TFolder[] = [];
        const ignoredFolders = this.settings.ignoredFolders;

        const collectFolders = (folder: TFolder) => {
            // Skip ignored folders
            const shouldSkip = ignoredFolders.some((ignore) =>
                folder.path.includes(ignore)
            );
            if (shouldSkip) {
                return;
            }

            // Skip hidden folders
            if (folder.name.startsWith(".")) {
                return;
            }

            folders.push(folder);

            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFolders(child);
                }
            }
        };

        // Start from root
        const root = this.app.vault.getRoot();
        folders.push(root); // Include root as "Entire vault"
        for (const child of root.children) {
            if (child instanceof TFolder) {
                collectFolders(child);
            }
        }

        return folders;
    }

    getItemText(folder: TFolder): string {
        if (folder.path === "/") {
            return "/ (Entire vault)";
        }
        return folder.path;
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(folder);
    }
}
