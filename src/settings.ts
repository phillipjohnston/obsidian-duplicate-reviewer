import { App, PluginSettingTab, Setting } from "obsidian";
import type DuplicateReviewerPlugin from "./main";
import { DuplicateReviewerSettings, DEFAULT_SETTINGS } from "./types";

export class DuplicateReviewerSettingTab extends PluginSettingTab {
    plugin: DuplicateReviewerPlugin;

    constructor(app: App, plugin: DuplicateReviewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl("h2", { text: "Duplicate Reviewer Settings" });

        // Similarity Thresholds Section
        containerEl.createEl("h3", { text: "Similarity Thresholds" });

        new Setting(containerEl)
            .setName("Title similarity threshold")
            .setDesc("Minimum title similarity (0-100%) to consider as potential duplicate")
            .addSlider((slider) =>
                slider
                    .setLimits(50, 100, 5)
                    .setValue(this.plugin.settings.titleSimilarityThreshold * 100)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.titleSimilarityThreshold = value / 100;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Enable content similarity checking")
            .setDesc("Compare file content in addition to titles when looking for duplicates")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableContentSimilarity)
                    .onChange(async (value) => {
                        this.plugin.settings.enableContentSimilarity = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.enableContentSimilarity) {
            new Setting(containerEl)
                .setName("Content similarity threshold")
                .setDesc("Minimum content similarity (0-100%) to flag as likely duplicate")
                .addSlider((slider) =>
                    slider
                        .setLimits(30, 100, 5)
                        .setValue(this.plugin.settings.contentSimilarityThreshold * 100)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.contentSimilarityThreshold = value / 100;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("Content characters to analyze")
                .setDesc("Number of characters from the start of each file to compare")
                .addText((text) =>
                    text
                        .setPlaceholder("1000")
                        .setValue(String(this.plugin.settings.contentCharsToAnalyze))
                        .onChange(async (value) => {
                            const num = parseInt(value, 10);
                            if (!isNaN(num) && num > 0) {
                                this.plugin.settings.contentCharsToAnalyze = num;
                                await this.plugin.saveSettings();
                            }
                        })
                );
        }

        // Folders Section
        containerEl.createEl("h3", { text: "Folders" });

        new Setting(containerEl)
            .setName("Ignored folders")
            .setDesc("Folders to skip when scanning (one per line)")
            .addTextArea((text) =>
                text
                    .setPlaceholder(".obsidian\n.git\n.trash")
                    .setValue(this.plugin.settings.ignoredFolders.join("\n"))
                    .onChange(async (value) => {
                        this.plugin.settings.ignoredFolders = value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        // Patterns Section
        containerEl.createEl("h3", { text: "Pattern Review" });

        new Setting(containerEl)
            .setName("Common patterns")
            .setDesc("Patterns to look for in pattern-based review (one per line)")
            .addTextArea((text) =>
                text
                    .setPlaceholder("Notes\nUntitled\nNew Note")
                    .setValue(this.plugin.settings.commonPatterns.join("\n"))
                    .onChange(async (value) => {
                        this.plugin.settings.commonPatterns = value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        // Comparison Section
        containerEl.createEl("h3", { text: "Comparison" });

        new Setting(containerEl)
            .setName("Maximum comparison panes")
            .setDesc("Maximum number of files to open side-by-side for comparison")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("2", "2 panes")
                    .addOption("3", "3 panes")
                    .addOption("4", "4 panes")
                    .setValue(String(this.plugin.settings.maxComparisonPanes))
                    .onChange(async (value) => {
                        this.plugin.settings.maxComparisonPanes = parseInt(value, 10);
                        await this.plugin.saveSettings();
                    })
            );
    }
}
