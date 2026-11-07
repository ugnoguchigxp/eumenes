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
	markdown?: string | null;
	remote?: {
		id: string;
		etag: string | null;
		namespace: string | null;
		path: string | null;
	} | null;
	conflict?: {
		entry: {
			sourceId: string;
			title: string;
			revision: string;
			namespace: string;
			path: string;
		};
		markdown: string;
		recovery: string;
	} | null;
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
export type MarkdownLibraryEntry = {
	sourceId: string;
	title: string;
	namespace: string;
	path: string;
};
export type MarkdownWorkspaceProps = {
	current: MarkdownCurrent | null;
	documents: { id: string; title: string }[];
	library: MarkdownLibraryEntry[];
	libraryStatus?: "idle" | "loading" | "ready" | "error";
	libraryHasMore?: boolean;
	namespaces?: string[];
	capabilities?: {
		maxMarkdownBytes: number;
		maxRecoveryBytes: number;
		maxRequestBytes: number;
	};
	archiveAvailable: boolean;
	archiveError?: string;
	cacheAvailable?: boolean;
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
	onCache?(
		draft: MarkdownDraft,
		markdown: string,
		requestId: string,
	): Promise<boolean>;
	onSelect(id: string): Promise<boolean> | void;
	onOpen(sourceId: string): Promise<boolean> | void;
	onLibrary(): void;
	onMore?(): void;
	onResolve?(id: string, revision: number, etag: string): Promise<boolean>;
	onReload?(id: string, revision: number): Promise<boolean>;
	onReconcile(id: string): void;
	onReturn(): void;
	onResume(): void;
	message?: string;
	pending?: boolean;
};
