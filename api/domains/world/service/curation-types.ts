import type { SourceRef } from "eumenes-memory";
import type {
	CanonicalHasher,
	Entity,
	RelationKind,
	ScopeRef,
} from "eumenes-world-model";
import type { SourceAdapter } from "../contracts";
import type { IntakePorts } from "./extraction-intake";
import type { WorldHostGate } from "./host-gate";
import type { WorldLifecycle } from "./lifecycle-adapter";
import type { MemoryPort } from "./lifecycle-memory";
import type { WorldService } from "./world-service";

/**
 * Curation: the World half of the steward's `curate-world` step. The steward owns the
 * model call and the transaction; this domain owns what the model may be shown, what of its
 * answer is accepted, and how an accepted claim becomes part of World. Every operation runs
 * inside the transaction the caller owns and throws (never partially applies) on a failure
 * that must roll that transaction back.
 */

export type CurationSpeaker = "user" | "assistant";

/** The most the model is shown. */
export const CURATION_LIMITS = {
	/** Candidate entities for the utterances' words and recent use. */
	entities: 30,
	/** Entities in the view, including the objects of relations the shown claims name. */
	entitiesWithObjects: 40,
	/** Live claims about the shown entities. */
	claims: 40,
	/** Entities one output may register. */
	newEntities: 4,
	/** Claims one output may carry (World's candidate limit). */
	outputClaims: 8,
} as const;

// --- what the model sees ----------------------------------------------------------

type CurationUtterance = {
	/** `e1`, `e2`, ... in the order of the window. A claim cites its evidence by this label. */
	label: string;
	speaker: CurationSpeaker;
	text: string;
};

export type CurationEntityView = {
	/** `w1`, `w2`, ... */
	ref: string;
	name: string;
	aliases: string[];
};

export type CurationValue =
	| { type: "string"; value: string }
	| { type: "boolean"; value: boolean }
	| { type: "number"; value: number; unit: string };

export type CurationClaimView = {
	/** `c1`, `c2`, ... A `correct` or `retract` names the claim by this ref. */
	ref: string;
	/** The `w` ref of the subject. */
	subject: string;
	predicate: string;
	value: CurationValue | null;
	relation: { kind: RelationKind; object: string } | null;
	status: "adopted" | "candidate" | "disputed";
	origin:
		| "user_report"
		| "document_claim"
		| "runtime_observation"
		| "model_hypothesis";
};

export type CurationModelView = {
	utterances: CurationUtterance[];
	entities: CurationEntityView[];
	claims: CurationClaimView[];
};

// --- what the host keeps ----------------------------------------------------------

export type CurationHostEvent = {
	label: string;
	eventId: string;
	messageId: string;
	conversationId: string;
	speaker: CurationSpeaker;
	source: SourceRef;
	manifestId: string;
	rootEvidenceId: string;
	/** The event's received cursor (the World checkpoint's applied position when it settles). */
	receivedCursor: string;
};

/**
 * The host's table of the window. It is opaque to the caller: pass it back unchanged with the
 * model's answer. Nothing in it is shown to a model, and the caller must not read or edit it.
 */
export type CurationHostTable = {
	version: 1;
	windowId: string;
	/** World's forget epoch at prepare: a forget since then voids the result (steward plan F6). */
	forgetEpoch: string;
	/** The digest of the Scope's entities at prepare; a held window is remembered under it. */
	entityDigest: string;
	events: CurationHostEvent[];
	/** What the model saw, whole sources, sorted: the manifest of every claim made from it. */
	dependencies: SourceRef[];
	/** The Memory dependents registered for this window (released when it is not settled). */
	dependentIds: string[];
	/** The package's utterance window (origin is the package's, `document_claim` for an assistant). */
	window: {
		utteranceId: string;
		source: SourceRef;
		origin: "user_report" | "document_claim";
		rootEvidenceId: string;
	}[];
	entities: { ref: string; id: string; revision: number }[];
	/** The shown entities as the validator needs them. */
	entitySnapshot: Entity[];
	claims: {
		ref: string;
		id: string;
		revision: number;
		subjectId: string;
		predicate: string;
		kind: "value" | "relation";
	}[];
};

export type PreparedCuration = {
	scope: ScopeRef;
	/** The events of this window, in order. */
	eventIds: string[];
	/** Requested events that did not fit the window or are held: still pending. */
	deferredEventIds: string[];
	model: CurationModelView;
	host: CurationHostTable;
};

/** An event this call settled `rejected` for good because its source can not be curated. */
export type CurationFinalized = {
	eventId: string;
	messageId: string;
	reason: string;
};

export type CurationPrepareResult =
	| {
			status: "ready";
			prepared: PreparedCuration;
			finalized: CurationFinalized[];
	  }
	| {
			/**
			 * `not_ready`: nothing can be done now but may be later (World unavailable, the window is held
			 * until the entities change, Memory refused). `stale`: nothing left to curate in these events
			 * (settled, gone, or finalized now).
			 */
			status: "not_ready" | "stale";
			reason: string;
			finalized: CurationFinalized[];
	  };

// --- the model's answer -----------------------------------------------------------

export type CurationOutputEntity = {
	name: string;
	aliases: string[];
};

export type CurationOutputClaim = {
	op: "assert" | "correct" | "retract";
	/** `c` ref of the claim a `correct` or `retract` changes. */
	ref: string | null;
	/** `w1`, `new:0` (the index of an entity of this output) or a plain name resolved among the shown entities. */
	subject: string | null;
	predicate: string | null;
	value: CurationValue | null;
	relation: { kind: RelationKind; object: string } | null;
	/** `e` label of the utterance the claim stands on. */
	evidence: string;
	origin: "user_report" | "model_hypothesis";
	/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
	validFrom: string | null;
	validUntil: string | null;
};

export type CurationElement = {
	kind: "entity" | "claim";
	/** Position in the output's `entities` or `claims`. */
	index: number;
	op: "register" | CurationOutputClaim["op"];
	status: "applied" | "dropped" | "held";
	/** Why an element was dropped or held (empty when applied). Host codes are lower case, World's are upper case. */
	reasonCodes: string[];
	/** What an applied claim became. */
	outcome?:
		| "adopted"
		| "adopted_hypothesis"
		| "corrected"
		| "retracted"
		| "registered";
	claimId?: string;
	entityId?: string;
	messageId?: string;
};

type CurationTouched = {
	claimIds: string[];
	entityIds: string[];
	messageIds: string[];
};

export type CurationSettleResult =
	| {
			status: "settled";
			elements: CurationElement[];
			/** Every event of the window is now settled `applied`. */
			eventIds: string[];
			touched: CurationTouched;
			/** True when World gained or changed anything beyond settling the events. */
			changed: boolean;
	  }
	| {
			/** A candidate could not be placed yet (ambiguous or unknown subject): the whole window waits. */
			status: "held";
			reasonCodes: string[];
			elements: CurationElement[];
	  }
	| {
			/** The world moved since prepare: nothing was applied. */
			status: "stale";
			reason:
				| "world_unavailable"
				| "forget_epoch_changed"
				| "input_changed"
				| "input_version_changed"
				| "source_blocked"
				| "entities_changed";
	  }
	| {
			/** The answer has no usable shape: nothing was applied, the events stay pending. */
			status: "invalid_output";
			reason: string;
	  };

// --- pending ----------------------------------------------------------------------

export type PendingCurationEvent = {
	eventId: string;
	messageId: string;
	revision: string;
	digest: string;
	speaker: CurationSpeaker;
	conversationId: string;
	/** Arrival order inside the Scope. */
	seq: number;
};

// --- forget -----------------------------------------------------------------------

export type SourceForgetRequest = {
	scope: ScopeRef;
	messageIds: readonly string[];
	/** Recorded as World's `SOURCE_FORGOTTEN` tombstone reason (the package has no other for a source). */
	reasonCode: "SOURCE_BLOCKED";
	origin: "steward";
};

export type ForgetAccepted = {
	status: "accepted";
	/** Resume it with `lifecycle.resumeForget(forgetId)` after the caller's transaction committed. */
	forgetId: string;
};

export type ForgetNothing = { status: "nothing" };
type ForgetUnavailable = {
	status: "unavailable";
	reason: string;
};

export type ClaimForgetResult =
	| (ForgetAccepted & {
			claimIds: string[];
			/** Ids that name no claim of the Scope. */
			missing: string[];
	  })
	| ForgetNothing
	| ForgetUnavailable;

export type EntityForgetResult =
	| (ForgetAccepted & { entityIds: string[]; missing: string[] })
	| ForgetNothing
	| ForgetUnavailable;

export type EvidenceMessages =
	| {
			status: "ok";
			/** Conversation message ids standing as evidence of those claims, every revision. */
			messageIds: string[];
			/** False when a read budget stopped the search: more messages may exist. */
			complete: boolean;
	  }
	| ForgetUnavailable;

// --- options ----------------------------------------------------------------------

export type CurationOptions = {
	world: WorldService;
	lifecycle: Pick<WorldLifecycle, "acceptForgetInTransaction">;
	/** One adapter per source namespace (scope check and content reader). */
	sources: readonly SourceAdapter[];
	/** What the host answers about a message: adopted answer, blocked. */
	intake: Pick<IntakePorts, "isAdoptedAnswer" | "blockedMessageIds">;
	/** Startup gate; while closed nothing is curated. */
	gate?: WorldHostGate;
	/** AccessContext.purpose of the reads and writes (the source adapters must allow it). */
	purpose?: string;
	clock?: () => number;
	hasher?: CanonicalHasher;
	/** Replace single Memory calls (tests); production uses the public API only. */
	memory?: Partial<MemoryPort>;
	interpretationVersion?: string;
};
