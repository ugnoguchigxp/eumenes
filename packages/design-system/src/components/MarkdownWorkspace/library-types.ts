import type { Dispatch, SetStateAction } from "react";
export type HeaderDeleteSelection = {
	selection: string[];
	setSelection: Dispatch<SetStateAction<string[]>>;
};
export type LibraryActionScope = {
	namespace: string;
	path: string;
	etag?: string;
};
export type LibraryItem = {
	kind: "document" | "folder";
	id: string;
	namespace: string;
	path: string;
	etag: string;
	title?: string;
	name?: string;
	contentDigest?: string;
	updatedAt?: string;
	documentCount?: number;
	folderCount?: number;
	hasUnsupportedEntries?: boolean;
};
export type LibraryFeatures = {
	library: boolean;
	folders: boolean;
	folderCopy?: boolean;
	patch: boolean;
	copy: boolean;
	delete: boolean;
	createFolder: boolean;
	recursiveDelete: boolean;
	batch: boolean;
	maxBatchItems: number;
	maxAffectedItems: number;
	maxCopyBytes: number;
};
export type LibraryFiles = {
	namespace: string;
	path: string;
	etag: string;
	entries: LibraryItem[];
	nextCursor: string | null;
};
export type LibraryOperation = {
	id: string;
	state: string;
	code: string | null;
	command: unknown;
	removedWorkspaceIds: string[];
};
