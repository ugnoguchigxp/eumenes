import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
	TerminalConnection,
} from "@eumenes/artifact-ui/contracts";
import type {
	ActionBindingV1,
	ArtifactDefinitionV1,
} from "../../../../api/domains/capabilities/contracts";
import type { ExecutionResultV1 } from "../../../../api/domains/tool-runtime/contracts";
import type { EumenesClient } from "../../../../client";
import type { ToolchainArtifactEntry } from "../../../../client/toolchain-actions";
import type { DocumentAccess, RegisteredField } from "./documents";
import type { DraftView } from "./drafts";
import { genericWebAdapter } from "./generic-adapter";

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
	conversationId?: string;
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	artifactRevisionId: string;
	/** The saved item shown by this screen (a host-issued ref such as a timer id), if any. */
	targetRef: string | undefined;
	setTargetRef: (ref: string | undefined) => void;
	/** False while the screen is hidden behind another tab. */
	visible: boolean;
	/** Every registered launcher artifact (labels and groups for navigation). */
	catalog: ReadonlyArray<ToolchainArtifactEntry>;
	/**
	 * Fields of each adapter document across all registered screens of this adapter, so a
	 * review screen can show a field another screen registered. Keyed by document ref.
	 */
	documentFields: Readonly<Record<string, ReadonlyArray<RegisteredField>>>;
	/** False while screens that register fields of those documents are still being read. */
	documentFieldsReady: boolean;
	/** The shared draft of each document this screen reads or applies, keyed by document ref. */
	drafts: Readonly<Record<string, DraftView>>;
	/** Shows a message in the screen's notice bar (e.g. a live link failure the adapter observed). */
	notify(message: string): void;
};

type AdapterPhase =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	/** The data cannot be shown (e.g. its body expired); the selector stays usable. */
	| { kind: "blocked"; message: string }
	| { kind: "ready" };

/** When the request left, measured on the page's clocks, for server-clock binding. */
type SendTiming = { sent: number; sentAt: number };

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
	/** Domain-owned binary input; the returned opaque id can be sent in a registered form. */
	uploadFile?(
		source: string,
		file: File,
		context?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<Receipt & { value?: string; canRetry?: boolean }>;
	/** Live PTY sessions of a terminal source (stream, ordered input, resize). */
	openTerminal?(source: string, sessionId: string): TerminalConnection;
	/** The target the host sends with an event of this source; undefined when it has none. */
	targetOf(source: string): string | undefined;
	/**
	 * An event with no registered action that asks for another page or view of this screen's own
	 * sources (paging, sorting, search of a table). The adapter answers with a read of the source
	 * and returns the receipt, or null when the event is not such a read. Nothing is written.
	 */
	sourceRead?(event: ArtifactEvent): Promise<Receipt> | null;
	/** A local action (clock mode, stopwatch, choosing "new"): never sent to the backend. */
	local(binding: ActionBindingV1, event: ArtifactEvent): Promise<Receipt>;
	/** A write was settled; reflect its domain receipt (and any new target) in the screen. */
	settled(
		binding: ActionBindingV1,
		result: ExecutionResultV1,
		timing: SendTiming,
		/** The input the action was sent with (e.g. the table query of a page read). */
		input: unknown,
	): void | Promise<void>;
	/** The server disagreed with what was shown (revision conflict): read the sources again. */
	refresh(): void;
	/**
	 * The saved copy of each adapter document this screen shows, with the rules the host uses to
	 * check draft edits and to build the apply input. Keyed by document ref.
	 */
	documents?: Readonly<Record<string, DocumentAccess>>;
	/**
	 * A draft edit of a control that is not a registered field (e.g. which voice target is being
	 * adjusted). Returns the receipt when the adapter handled it, null otherwise.
	 */
	editLocal?(fieldKey: string, wire: string): Receipt | null;
	/** Domain contract validation before a structural form relinquishes its input. */
	validateStructure?(
		structure: string,
		input: Record<string, unknown>,
		secrets: ReadonlyArray<{ fieldId: string; value: unknown }>,
	): Receipt;
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
	/**
	 * Brings the saved item `targetRef` into view on the open screen and marks it for about two
	 * seconds. Resolves false when the screen has no such item. Not a hook: a screen that
	 * supports it reaches its mounted instance through `createLiveScreen`.
	 */
	focus?(targetRef: string): Promise<boolean>;
	/**
	 * Starts playback of the saved item. Rejects with the media element's `NotAllowedError` when
	 * the browser refuses playback without a user gesture.
	 */
	play?(targetRef: string): Promise<void>;
	/** The resource URI of the item the open screen shows now, or null (none, or hidden). */
	viewing?(): string | null;
};

/**
 * The mounted instance of one adapter's screen. A hook attaches a handle that reads the screen's
 * latest state; the adapter's non-hook methods (`focus`, `play`, `viewing`) read through it.
 */
export function createLiveScreen<Handle>() {
	let current: Handle | null = null;
	return {
		/** Called from an effect of the screen; returns the detach. */
		attach(handle: Handle): () => void {
			current = handle;
			return () => {
				if (current === handle) current = null;
			};
		},
		current: (): Handle | null => current,
		/**
		 * Waits until the mounted screen satisfies `read` (a truthy result), polling because the
		 * screen's data arrives through its own queries; null when it does not in time.
		 */
		async waitFor<Result>(
			read: (handle: Handle) => Result | null | undefined | false,
			timeoutMs = 5_000,
		): Promise<Result | null> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (current) {
					const value = read(current);
					if (value) return value;
				}
				if (Date.now() >= deadline) return null;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		},
	};
}

export type WebAdapterRegistry = {
	get(adapterRef: string): WebArtifactAdapter | undefined;
};

/**
 * An adapterRef with no domain Web adapter is shown by the generic one: lists, forms and writes
 * come from the registration, so domain Web code is only needed for special UI.
 */
export function createWebAdapterRegistry(
	adapters: readonly WebArtifactAdapter[],
): WebAdapterRegistry {
	const map = new Map(adapters.map((a) => [a.adapterRef, a] as const));
	if (map.size !== adapters.length) throw new Error("duplicate_web_adapter");
	return { get: (ref) => map.get(ref) ?? genericWebAdapter };
}
