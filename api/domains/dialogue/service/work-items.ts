import type { WorkLink } from "../contracts/resources";
import { replaceResourceUrisIn } from "./resource-text";

/** A TODO as the conversation sees it: a projection of the execution ledger. */
export type TodoItem = {
	id: string;
	/** The conversation's number of the TODO (`t<ref>`). */
	ref: number;
	/** The toolchain the work was handed to. */
	toolchainId?: string;
	/** The resources the finished work made; absent when none. */
	links?: WorkLink[];
	title: string;
	status: "todo" | "waiting" | "done";
	outcome?: string;
	questionId?: string;
	question?: string;
};

/** A confirmation the host issued before executing a change. */
export type PendingConfirmation = {
	id: string;
	/** The conversation's number of the confirmation (`c<ref>`). */
	ref: number;
	toolchain: string;
	request: string;
	impact: string;
	/** The name of the saved item it changes, as the confirmation showed it. */
	target: string | null;
};

/** The numbers the model reads host records by: a TODO's `t<ref>`, a confirmation's `c<ref>`, a resource's `a<ref>`. */
export type DocumentRefs = {
	todo(id: string): string | null;
	confirmation(id: string): string | null;
	/** `a<n>` of a resource URI in the conversation's ledger; null when it is not there. */
	resource(uri: string): string | null;
};

/** A result as the model reads it: a resource is its number, never its URI. */
export function hideUris(value: unknown, refs: DocumentRefs): unknown {
	return replaceResourceUrisIn(
		value,
		(uri) => refs.resource(uri) ?? "リソース",
	);
}
