import type { Database } from "bun:sqlite";
import type {
	ConversationResourcesResponse,
	ResourceRegistry,
} from "../../resources";
import type {
	ConversationResource,
	ConversationResourcePort,
	WorkLink,
} from "../contracts/resources";
import {
	allResources,
	insertResource,
	linkMessageResources,
	messageResourceUris,
	reenterResource,
	resourceById,
	resourceByRef,
	resourceByUri,
	resourcesOfMessage,
	touchResource,
	usedResources,
	workLinksOf,
} from "../repository/resources";
import type { DialogueDeps } from "./context";

/** What dialogue needs of the resources: the registry the application wired, and which kinds a toolchain makes. */
export type ResourceAccess = {
	registry: ResourceRegistry;
	/** The resource kinds a toolchain's results create (capabilities `producesInTransaction`). */
	producesInTransaction(db: Database, toolchainId: string): string[];
};

/** The number the model reads a resource by: `a<ref>`. */
export const resourceName = (ref: number) => `a${ref}`;

/**
 * The conversation's resource ledger (spec resource-uri-implementation-plan-2026-10-25.md section 4.2): the
 * resources the conversation has met, each with a stable number, and the ones each message shows as chips.
 */
export function createResourceLedger(deps: Pick<DialogueDeps, "clock" | "id">) {
	const port: ConversationResourcePort = {
		enterInTransaction(db, input) {
			const at = deps.clock();
			const known = resourceByUri(db, input.conversationId, input.uri);
			if (!known)
				return insertResource(db, {
					id: deps.id(),
					conversationId: input.conversationId,
					uri: input.uri,
					kind: input.kind,
					label: input.label,
					source: input.source,
					workId: input.workId ?? null,
					usedAt: at,
					createdAt: at,
				});
			// The TODO that made a resource is its origin; a shown one keeps the origin it had.
			const fromWork = input.source === "work" && !!input.workId;
			// Forgotten stays forgotten: finding or viewing it again never brings back its number and label.
			if (known.forgottenAt && !fromWork) return known;
			const keep = !fromWork;
			reenterResource(db, known.id, {
				label: input.label,
				source: keep ? known.source : input.source,
				workId: keep ? known.workId : (input.workId ?? null),
				usedAt: at,
			});
			return resourceById(db, known.id)!;
		},
		byRefInTransaction(db, conversationId, ref) {
			const match = /^a(\d+)$/.exec(ref);
			return match ? resourceByRef(db, conversationId, Number(match[1])) : null;
		},
		touchInTransaction(db, resourceId) {
			touchResource(db, resourceId, deps.clock());
		},
		linkMessageInTransaction(db, messageId, resourceIds) {
			linkMessageResources(db, messageId, resourceIds);
		},
	};
	return {
		...port,
		/** The resource of this URI in the conversation, forgotten or not. */
		byUriInTransaction: resourceByUri,
		/** The resources a message shows as chips, in their order, forgotten ones left out. */
		ofMessageInTransaction: (db: Database, messageId: string) =>
			resourcesOfMessage(db, messageId).filter((row) => !row.forgottenAt),
		/** The resources not forgotten, most recently used first. */
		recentInTransaction: usedResources,
		/** The number each resource URI of the conversation has (forgotten ones have none). */
		numbersInTransaction(db: Database, conversationId: string) {
			const numbers = new Map<string, number>();
			for (const row of allResources(db, conversationId))
				if (!row.forgottenAt) numbers.set(row.uri, row.ref);
			return numbers;
		},
		/** Enters a TODO's links into the ledger, keeping the order they have. */
		enterLinksInTransaction(
			db: Database,
			input: { conversationId: string; workId: string; links: WorkLink[] },
		): ConversationResource[] {
			return input.links.map((link) =>
				port.enterInTransaction(db, {
					conversationId: input.conversationId,
					uri: link.uri,
					kind: link.kind,
					label: link.label,
					source: "work",
					workId: input.workId,
				}),
			);
		},
		/**
		 * Links the resources of these TODOs to a message: what a report of them shows as chips. A TODO without
		 * links, or whose resource was forgotten, adds none.
		 */
		linkMessageToWorkInTransaction(
			db: Database,
			conversationId: string,
			messageId: string,
			workIds: readonly string[],
		) {
			const links = workLinksOf(db, workIds);
			const ids: string[] = [];
			for (const workId of workIds)
				for (const link of links.get(workId) ?? []) {
					const row = resourceByUri(db, conversationId, link.uri);
					if (row && !row.forgottenAt && !ids.includes(row.id))
						ids.push(row.id);
				}
			if (ids.length) port.linkMessageInTransaction(db, messageId, ids);
		},
		/** `GET /api/conversations/:id/resources`: the ledger as the Web shows it, and each message's chips. */
		responseInTransaction(
			db: Database,
			registry: ResourceRegistry,
			conversationId: string,
		): ConversationResourcesResponse {
			const resources: ConversationResourcesResponse["resources"] = [];
			for (const row of allResources(db, conversationId)) {
				if (row.forgottenAt) continue;
				const resolved = registry.resolveInTransaction(db, row.uri);
				if (!resolved.ok) continue;
				const view = resolved.resource;
				resources.push({
					ref: resourceName(row.ref),
					uri: row.uri,
					kind: view.kind,
					kindLabel: view.kindLabel,
					label: view.label,
					actions: view.actions,
					...(view.preview ? { preview: view.preview } : {}),
					forgotten: false,
				});
			}
			const shown = new Set(resources.map((resource) => resource.uri));
			const byMessage = new Map<string, string[]>();
			for (const { messageId, uri } of messageResourceUris(db, conversationId))
				if (shown.has(uri))
					byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), uri]);
			return {
				resources,
				messages: [...byMessage].map(([messageId, uris]) => ({
					messageId,
					uris,
				})),
			};
		},
	};
}
export type ResourceLedger = ReturnType<typeof createResourceLedger>;

/** `GET /api/conversations/:id/resources`: the conversation's resources and each message's chips; none without resources. */
export function conversationResources(
	deps: Pick<DialogueDeps, "store" | "resources" | "resourceLedger">,
	conversationId: string,
): ConversationResourcesResponse {
	const { resources, resourceLedger } = deps;
	return resources && resourceLedger
		? deps.store.read((db) =>
				resourceLedger.responseInTransaction(
					db,
					resources.registry,
					conversationId,
				),
			)
		: { resources: [], messages: [] };
}
