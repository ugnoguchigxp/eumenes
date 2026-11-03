import type { Database } from "bun:sqlite";
import { systemContext } from "../../../infrastructure/system-context";
import { CONVERSATION_ID, MEMORY_ID } from "./routed-route";

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
		const kinds = db
			.query(
				"SELECT DISTINCT r.kind FROM dialogue_resources r WHERE r.conversation_id=? AND r.forgotten_at IS NULL AND (r.uri=? OR r.id IN (SELECT resource_id FROM dialogue_message_resources WHERE message_id=?)) ORDER BY r.kind",
			)
			.all(
				run.conversation_id,
				run.viewing_resource,
				run.input_message_id,
			) as Array<{ kind: string }>;
		return {
			...run,
			resourceKinds: kinds.length ? kinds.map((row) => row.kind) : null,
		};
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
