/**
 * The task pipeline studio's snapshot resource (types only; spec task-pipeline-design 2026-10-22 §8, §13.6).
 * The host's `query:pipelines.studio@1` source returns `data` in this shape; the Web adapter adds `revision`,
 * `session` and `stoppable` as it does for the UI studio.
 */

/** A finding of the pipeline check: where (JSON Pointer, and its line in `source` when known) and which rule. */
export type PipelineStudioIssue = {
	pointer: string;
	rule: string;
	/** 1-based line of the pointer in `source`; null when it names no line there. */
	line: number | null;
};

/** One step of the flow, for the diagram: what it hands to which toolchain and what earlier values it reads. */
export type PipelineStudioStep = {
	id: string;
	kind: "toolchain" | "extract";
	title: string;
	/** The toolchain a toolchain step hands to; null for an extract step. */
	toolchain: string | null;
	/** Ids of the earlier steps whose values this step's templates (or `uses`) read. */
	reads: string[];
	/** Names of the inputs this step's templates read. */
	inputs: string[];
};

export type PipelineStudioWork = {
	workRef: string;
	sessionId: string;
	title: string;
	/** Draft revision; sent back as `expectedRevision` by source apply and publish. */
	revision: number;
	/** The canonical text of the draft (keys in schema order, 2-space indent); "" when empty. */
	source: string;
	/** The canonical text of the revision before the current one; "" when there is none. */
	previousSource: string;
	/** The last whole draft that failed the format check, until the next accepted change. */
	rejected: {
		title: string;
		text: string;
		issues: Array<{ path: string; rule: string }>;
		fixes: string[];
		createdAt: string;
	} | null;
	/** The full check of the current draft (references, toolchains, examples); empty when it would publish. */
	issues: PipelineStudioIssue[];
	/** The draft as a flow; null while the draft is empty or does not read as a pipeline. */
	flow: {
		inputs: Array<{ name: string; type: string; required: boolean }>;
		steps: PipelineStudioStep[];
		/** Names of the inputs and ids of the steps the final answer template reads. */
		answer: { inputs: string[]; reads: string[] } | null;
	} | null;
	/** The fixture cases of the draft, for the trial run. */
	tests: Array<{ index: number; utterance: string }>;
	/** The published revision of this pipeline's id, if any. */
	published: {
		toolchainRevisionId: string;
		functionName: string;
		revision: number;
	} | null;
	/** The draft differs from the published revision (or was never published). */
	dirty: boolean;
	/** A specialist turn is running: source apply and publish are unavailable. */
	busy: boolean;
};

/** Where the draft and the other toolchains rank for one wording (the host's probe; mirrors client/pipelines). */
export type PipelineStudioProbe =
	| {
			ok: true;
			candidates: Array<{
				toolchainId: string;
				title: string;
				functionName: string;
				rank: number;
				similarity: number | null;
				ftsRank: number | null;
				draft: boolean;
			}>;
			passages: Array<{ text: string; similarity: number }>;
	  }
	| { ok: false; issues: Array<{ pointer: string; rule: string }> }
	| { ok: false; code: string };
/** What the first round chose for one utterance, nothing run. */
export type PipelineStudioSelection =
	| {
			ok: true;
			chosen: string | null;
			matched: boolean;
			next: string | null;
			inputs: Record<string, unknown> | null;
			code: string | null;
	  }
	| { ok: false; issues: Array<{ pointer: string; rule: string }> }
	| { ok: false; code: string };
/** One fixture case run without toolchains. */
export type PipelineStudioFixture =
	| {
			ok: true;
			outcome: {
				passed: boolean;
				steps: Array<{
					id: string;
					request?: string;
					arguments?: unknown;
					fault?: string;
				}>;
				answer?: string;
				failures: Array<{
					path: string;
					code: string;
					expected?: unknown;
					actual?: unknown;
				}>;
			};
	  }
	| { ok: false; issues: Array<{ pointer: string; rule: string }> };

/** The last trial run on this screen: the Web adapter's local state, never stored by the host. */
export type PipelineStudioTrial =
	| {
			kind: "probe";
			query: string;
			pending: boolean;
			result: PipelineStudioProbe | null;
	  }
	| {
			kind: "select";
			utterance: string;
			pending: boolean;
			result: PipelineStudioSelection | null;
	  }
	| {
			kind: "fixture";
			test: number;
			pending: boolean;
			result: PipelineStudioFixture | null;
	  };

export type PipelineStudioResource = {
	kind: "pipeline-studio";
	revision: number;
	work: PipelineStudioWork | null;
	/** Published pipelines, newest first. */
	history: Array<{
		toolchainId: string;
		title: string;
		toolchainRevisionId: string;
	}>;
	/** The dialogue session of this work, when the host knows one. */
	session: { state: "active" | "suspended"; expiresAt: string } | null;
	/** True when a turn of the session can be cancelled (stop). */
	stoppable: boolean;
	/** The last trial (probe, selection test, fixture run); null before any. */
	trial: PipelineStudioTrial | null;
};
