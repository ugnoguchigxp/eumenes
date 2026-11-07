import type { Value } from "platejs";
export type MarkdownDocument = {
	formatVersion: 1;
	nodes: Value;
	originalMarkdown: string | null;
};
export type MarkdownCurrent = {
	id: string;
	title: string;
	document: MarkdownDocument;
	revision: number;
	sourceId: string | null;
	dirty: boolean;
	saveState: string;
	saveError: string | null;
};
export type MarkdownDraft = {
	documentId: string;
	baseRevision: number;
	title: string;
	document: MarkdownDocument;
};
export type MarkdownWorkspaceProps = {
	current: MarkdownCurrent | null;
	documents: { id: string; title: string }[];
	library: { sourceId: string; title: string }[];
	archiveAvailable: boolean;
	sessionState?: "active" | "suspended" | null;
	busy?: boolean;
	recovery?: MarkdownDraft | null;
	onDraft(draft: MarkdownDraft | null): void;
	onApply(draft: MarkdownDraft): Promise<boolean>;
	onNew(title: string, document: MarkdownDocument): Promise<boolean>;
	onSave(
		documentId: string,
		revision: number,
		markdown: string,
	): Promise<boolean>;
	onSelect(id: string): void;
	onOpen(sourceId: string): void;
	onLibrary(): void;
	onReconcile(id: string): void;
	onReturn(): void;
	onResume(): void;
	message?: string;
	pending?: boolean;
};
