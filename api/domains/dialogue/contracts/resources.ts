import type { Database } from "bun:sqlite";

/**
 * The conversation's resource ledger (spec/resource-uri-implementation-plan-2026-10-25.md §4.2): every resource
 * the conversation has met, numbered `a<n>` for the model. The URI is the identity; the model never sees it.
 */
/** `attached`: the user's input as a shared file (an attachment, a long paste). */
export type ConversationResourceSource = "work" | "found" | "viewed" | "attached";

export type ConversationResource = {
	id: string;
	conversationId: string;
	/** The conversation's number (`a<ref>`). */
	ref: number;
	uri: string;
	kind: string;
	label: string;
	source: ConversationResourceSource;
	workId: string | null;
	usedAt: string;
	createdAt: string;
	forgottenAt: string | null;
};

/** A TODO's links (`dialogue_work.links_json`): what the finished work made. */
export type WorkLink = { uri: string; kind: string; label: string };

/** What the other parts of the host use of the ledger. */
export interface ConversationResourcePort {
	/** Enters a resource (or touches it when known) and returns its number; the same URI keeps its number. */
	enterInTransaction(
		db: Database,
		input: {
			conversationId: string;
			uri: string;
			kind: string;
			label: string;
			source: ConversationResourceSource;
			workId?: string;
		},
	): ConversationResource;
	/** `a<n>` → the resource, or null when unknown or forgotten. */
	byRefInTransaction(
		db: Database,
		conversationId: string,
		ref: string,
	): ConversationResource | null;
	/** Marks a resource as used now (it moves to the top of `<state>`). */
	touchInTransaction(db: Database, resourceId: string): void;
	/** Links resources to a message (its chips); ordinal follows the given order. */
	linkMessageInTransaction(
		db: Database,
		messageId: string,
		resourceIds: readonly string[],
	): void;
}

/**
 * The conversation's shared files (spec/server-scratch-cache-design-2026-11-07.md §3・§8.1), owned by the
 * application. Their URIs are ordinary resources; the dialogue only numbers and shows them.
 */
export interface SharedFilesPort {
	/**
	 * Before the input's transaction: the URIs of its shared files (its image attachments, its other files, a long
	 * paste it writes now).
	 */
	inputUris(input: {
		requestId: string;
		conversationId: string;
		text: string;
		attachmentIds: readonly string[];
		fileIds: readonly string[];
	}): Promise<string[]>;
	/** The conversation's shared files, most recently used first. */
	recentUris(conversationId: string, limit: number): string[];
}
