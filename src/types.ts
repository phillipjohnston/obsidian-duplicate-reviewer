import { TFile } from "obsidian";

export interface DuplicateCandidate {
    file1: TFile;
    file2: TFile;
    titleSimilarity: number;
    contentSimilarity?: number;
    likelyDuplicate?: boolean;
}

export interface DuplicateGroup {
    normalizedTitle: string;
    originalTitles: Set<string>;
    files: TFile[];
    candidates: DuplicateCandidate[];
}

export interface DuplicateReviewerSettings {
    titleSimilarityThreshold: number;
    enableContentSimilarity: boolean;
    contentSimilarityThreshold: number;
    contentCharsToAnalyze: number;
    ignoredFolders: string[];
    commonPatterns: string[];
    maxComparisonPanes: number;
}

export const DEFAULT_SETTINGS: DuplicateReviewerSettings = {
    titleSimilarityThreshold: 0.8,
    enableContentSimilarity: false,
    contentSimilarityThreshold: 0.6,
    contentCharsToAnalyze: 1000,
    ignoredFolders: [".obsidian", ".git", ".trash", "998 Readwise"],
    commonPatterns: ["Notes", "Untitled", "Note", "New Note"],
    maxComparisonPanes: 3,
};
