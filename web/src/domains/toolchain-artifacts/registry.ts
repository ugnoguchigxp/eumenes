import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import type {
	ActionBindingV1,
	ArtifactDefinitionV1,
} from "../../../../api/domains/capabilities/contracts";
import type { ExecutionResultV1 } from "../../../../api/domains/tool-runtime/contracts";
import type { EumenesClient } from "../../../../client";

/** An open question of the artifact's chain, as the host read it from the interactions API. */
export type OpenQuestion = {
	interactionId: string;
	questionId: string;
	revision: number;
	prompt: string;
	inputSchemaRef: string;
	/** Host-issued choices (ref + label); never model text. */
	choices?: ReadonlyArray<{ ref: string; label: string }>;
};

export type AdapterHostContext = {
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	artifactRevisionId: string;
	/** The saved item shown by this screen (a host-issued ref such as a timer id), if any. */
	targetRef: string | undefined;
	setTargetRef: (ref: string | undefined) => void;
	/** False while the screen is hidden behind another tab. */
	visible: boolean;
};

export type AdapterPhase =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	/** The data cannot be shown (e.g. its body expired); the selector stays usable. */
	| { kind: "blocked"; message: string }
	| { kind: "ready" };

/** When the request left, measured on the page's clocks, for server-clock binding. */
export type SendTiming = { sent: number; sentAt: number };

export type AnswerInput =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; message: string };

/**
 * What a domain contributes to the common host. The host owns registration lookup, variants,
 * action routing, the outbox and reconciliation; the adapter owns source data (including clocks)
 * and how a settled domain receipt changes the screen.
 */
export type AdapterState = {
	phase: AdapterPhase;
	/** A resource per source in `artifact.sourceBindings` (the question source is the host's). */
	snapshot: Snapshot;
	/** The target the host sends with an event of this source; undefined when it has none. */
	targetOf(source: string): string | undefined;
	/** A local action (clock mode, stopwatch, choosing "new"): never sent to the backend. */
	local(binding: ActionBindingV1, event: ArtifactEvent): Promise<Receipt>;
	/** A write was settled; reflect its domain receipt (and any new target) in the screen. */
	settled(
		binding: ActionBindingV1,
		result: ExecutionResultV1,
		timing: SendTiming,
	): void;
	/** The server disagreed with what was shown (revision conflict): read the sources again. */
	refresh(): void;
	/** Domain wording for a rejected input; undefined falls back to the host's wording. */
	describeRejection?(
		code: string | undefined,
		fieldErrors: ReadonlyArray<{ field: string; message: string }>,
	): string | undefined;
	/** Converts the text of an answer into the registered question schema's input. */
	answerInput?(question: OpenQuestion, text: string): AnswerInput;
};

export type WebArtifactAdapter = {
	/** `adapter:<owner>@<n>`; matches the artifact's source bindings. */
	adapterRef: string;
	/** A hook: the host renders one component per adapter, so the call order is stable. */
	useArtifact(context: AdapterHostContext): AdapterState;
};

export type WebAdapterRegistry = {
	get(adapterRef: string): WebArtifactAdapter | undefined;
};

export function createWebAdapterRegistry(
	adapters: readonly WebArtifactAdapter[],
): WebAdapterRegistry {
	const map = new Map(adapters.map((a) => [a.adapterRef, a] as const));
	if (map.size !== adapters.length) throw new Error("duplicate_web_adapter");
	return { get: (ref) => map.get(ref) };
}
