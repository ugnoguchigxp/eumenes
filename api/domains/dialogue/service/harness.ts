import type { InferencePort } from "../../inference";
import {
	SYSTEM_SECTIONS,
	TALK_SECTIONS,
	type SystemSection,
	type SystemTexts,
} from "./context-system";

type Snapshot = ReturnType<NonNullable<InferencePort["snapshotInTransaction"]>>;
type Connection = Snapshot["connections"][number];

export type HarnessName = "cloud" | "local";

/**
 * How the conversation is composed and called for one kind of model (the conversation harness design, section 4.1):
 * the parts of the input and its order, the call's settings and the gate on the answer. A run uses one harness from
 * its claim to its end.
 */
export type ConversationHarness = {
	name: HarnessName;
	/** The system part's sections, in the order they are written. */
	system: readonly SystemSection[];
	/**
	 * The texts the sections carry: `full` for a reply that calls the tools itself, `talk` for the local talk turn,
	 * which names no toolchain or tool (the local harness rebuild plan, section 4.2).
	 */
	systemTexts: SystemTexts;
	history: {
		/** The searches and hand-overs of the turn a request was made in. */
		toolExchanges: boolean;
		/** The one-line notice a report follows. */
		notices: boolean;
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
	/**
	 * How a turn runs: `single`, the agent's reply loop calls the tools itself; `routed`, the host routes each turn by
	 * the user-intent judge and what it holds pending, then talks or has one choice made (the local harness rebuild
	 * plan, section 4).
	 */
	turn: "single" | "routed";
};

/** The harness for a model served by a cloud connection. */
export const cloudHarness: ConversationHarness = {
	name: "cloud",
	system: SYSTEM_SECTIONS,
	systemTexts: "full",
	history: { toolExchanges: true, notices: true, copyFilter: true },
	call: { reasoning: "low", outputLimit: 1024 },
	gates: { systemCopy: true },
	turn: "single",
};

/**
 * The harness for a model served by LARM (the local harness rebuild plan): the host routes each turn, the talk turn
 * reads a talk-only system and the last two of the user's utterances, and no call carries tool definitions. The
 * background calls on the conversation share its prefix. It thinks at `low`, the least level every served model
 * accepts (one refused `none` with 400, 2026-10-29); its limit holds the thinking and the answer.
 */
export const localHarness: ConversationHarness = {
	name: "local",
	system: TALK_SECTIONS,
	systemTexts: "talk",
	history: { toolExchanges: false, notices: false, copyFilter: true, users: 2 },
	call: { reasoning: "low", outputLimit: 4096 },
	gates: { systemCopy: true },
	turn: "routed",
};

/** The harness for the kind of connection that serves the conversation (LARM has none). */
export const harnessFor = (kind: Connection["kind"] | "larm") =>
	kind === "larm" ? localHarness : cloudHarness;

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

/**
 * The harness of a run, from the settings it captured; a run with none is served by LARM. It builds the run's input;
 * a `larm-preferred` call that falls back to the cloud mid-run takes the cloud harness's call settings (section 4.3).
 */
export function harnessOf(snapshot: Snapshot | null): ConversationHarness {
	const connection = snapshot ? cloudConnection(snapshot) : null;
	return harnessFor(connection ? connection.kind : "larm");
}
