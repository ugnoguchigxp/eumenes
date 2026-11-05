import type { Database } from "bun:sqlite";
import { cardDigest, type Card } from "eumenes_router";
import { systemContext } from "../../../infrastructure/system-context";
import { CONVERSATION_ID, MEMORY_ID } from "./routed-route";

/** The kinds of what a run refers to: the resource it was viewing and the resources its message carries. */
function resourceKindsOf(
	db: Database,
	run: {
		conversation_id: string;
		input_message_id: string;
		viewing_resource: string | null;
	},
): string[] {
	return (
		db
			.query(
				"SELECT DISTINCT r.kind FROM dialogue_resources r WHERE r.conversation_id=? AND r.forgotten_at IS NULL AND (r.uri=? OR r.id IN (SELECT resource_id FROM dialogue_message_resources WHERE message_id=?)) ORDER BY r.kind",
			)
			.all(
				run.conversation_id,
				run.viewing_resource,
				run.input_message_id,
			) as Array<{ kind: string }>
	).map((row) => row.kind);
}

/**
 * The kind of the resource a run's utterance refers to, as the router package's evaluation data gave it (the first of
 * the run's resource kinds); null when it refers to none.
 */
export function referencedKindInTransaction(
	db: Database,
	runId: string,
): string | null {
	const run = db
		.query(
			"SELECT conversation_id,input_message_id,viewing_resource FROM dialogue_runs WHERE id=?",
		)
		.get(runId) as {
		conversation_id: string;
		input_message_id: string;
		viewing_resource: string | null;
	} | null;
	return run ? (resourceKindsOf(db, run)[0] ?? null) : null;
}

export function routingExportRuns(db: Database, since: number) {
	const runs = db
		.query(
			"SELECT id,conversation_id,input_message_id,created_at,viewing_resource FROM dialogue_runs WHERE created_at>=? AND specialist_session_id IS NULL ORDER BY created_at,id",
		)
		.all(new Date(since).toISOString()) as Array<{
		id: string;
		conversation_id: string;
		input_message_id: string;
		created_at: string;
		viewing_resource: string | null;
	}>;
	return runs.map((run) => {
		const kinds = resourceKindsOf(db, run);
		return { ...run, resourceKinds: kinds.length ? kinds : null };
	});
}
/** Static non-toolchain choices have no embedding passages or persisted revision. */
export function routingExportFixedCards() {
	return [
		{
			id: CONVERSATION_ID,
			kind: "conversation",
			text: systemContext("dialogue.contexts.local.router-conversation", {}),
		},
		{
			id: MEMORY_ID,
			kind: "memory",
			text: systemContext("dialogue.contexts.local.memory-request", {}),
		},
	].map(({ id, kind, text }) => ({
		id,
		kind,
		name: id,
		description: text,
		useWhen: [],
		avoidWhen: null,
		examples: null,
		operation: null,
		minImpact: null,
		highImpact: null,
		requiresApproval: null,
		enabled: true,
		version: null,
		revisionId: null,
		updatedAt: null,
		embeddingText: null,
		embeddingPassages: null,
		routerText: text,
	}));
}

/**
 * The conversation's and a memory request's cards for the router package (spec router-package-integration 2026-11-04
 * §1 #7), as its evaluation data had them: named by their id, described by the router's sentences.
 */
export function routerFixedCards(): Card[] {
	return [
		[CONVERSATION_ID, "dialogue.contexts.local.router-conversation"],
		[MEMORY_ID, "dialogue.contexts.local.memory-request"],
	].map(([id, key]) => {
		const body = {
			id: id!,
			revision: "1",
			kind: "general" as const,
			title: id!,
			summary: systemContext(
				key as "dialogue.contexts.local.memory-request",
				{},
			),
			useWhen: [],
			examples: [],
			impact: "none" as const,
		};
		return { ...body, digest: cardDigest(body) };
	});
}
