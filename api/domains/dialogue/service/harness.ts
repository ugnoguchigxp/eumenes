import type { InferencePort } from "../../inference";

type Snapshot = ReturnType<NonNullable<InferencePort["snapshotInTransaction"]>>;
type Connection = Snapshot["connections"][number];

/**
 * How the conversation is composed and called (the conversation harness design, section 4.1; the single harness plan):
 * the parts of the input, the call's settings and the gate on the answer. Every model, served by LARM or by a cloud
 * connection, runs the same host-routed turns; a run uses the harness from its claim to its end.
 */
export type ConversationHarness = {
	history: {
		/** Leave out the agent's utterances that copy the system part. */
		copyFilter: boolean;
		/** The user's utterances the recent conversation keeps, with the agent's words after the oldest; absent: all. */
		users?: number;
	};
	call: {
		reasoning: "off" | "low" | "medium" | "high";
		/** Tokens of one model call, the reasoning included. */
		outputLimit: number;
	};
	gates: {
		/** An answer that copies the system part fails. */
		systemCopy: boolean;
	};
};

/**
 * The harness of the conversation (the local harness rebuild plan, the single harness plan): the host routes each
 * turn, the talk turn reads a talk-only system and the last two of the user's utterances, and no call carries tool
 * definitions. The background calls on the conversation reuse its history under their own system (the agency
 * SystemContext integration). It thinks at `low`, the least level every
 * served model accepts (one refused `none` with 400, 2026-10-29); its limit holds the thinking and the answer.
 */
export const localHarness: ConversationHarness = {
	history: { copyFilter: true, users: 2 },
	call: { reasoning: "low", outputLimit: 4096 },
	gates: { systemCopy: true },
};

/**
 * The connection of the saved conversation model when the saved route picks it: `cloud-only` with a `fallbackId`
 * that names an `llm` resource whose connection exists and is enabled; null otherwise.
 */
function cloudConnection(snapshot: Snapshot): Connection | null {
	const route = snapshot.routes.llm;
	if (route.mode !== "cloud-only" || !route.fallbackId) return null;
	const resource = snapshot.resources.find(
		(r) => r.id === route.fallbackId && r.purpose === "llm",
	);
	const connection = snapshot.connections.find(
		(c) => c.id === resource?.connectionId,
	);
	return connection?.enabled ? connection : null;
}

/**
 * Fixes the conversation model's route of a run (section 4.3): the saved cloud model when the saved route picks it,
 * LARM otherwise. Only `routes.llm` is decided here; speech recognition and synthesis keep their saved routes.
 */
export function routeConversation(snapshot: Snapshot): void {
	const cloud = cloudConnection(snapshot);
	snapshot.routes.llm.mode = cloud ? "cloud-only" : "larm-only";
	snapshot.routes.llm.cloudAllowed = !!cloud;
}
