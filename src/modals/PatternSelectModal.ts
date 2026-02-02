import { App, FuzzySuggestModal } from "obsidian";
import { DuplicateReviewerSettings } from "src/types";

export class PatternSelectModal extends FuzzySuggestModal<string> {
    private settings: DuplicateReviewerSettings;
    private onChoose: (pattern: string) => void;

    constructor(
        app: App,
        settings: DuplicateReviewerSettings,
        onChoose: (pattern: string) => void
    ) {
        super(app);
        this.settings = settings;
        this.onChoose = onChoose;
        this.setPlaceholder("Select a pattern to find matching notes...");
    }

    getItems(): string[] {
        return this.settings.commonPatterns;
    }

    getItemText(pattern: string): string {
        return pattern;
    }

    onChooseItem(pattern: string, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(pattern);
    }
}
