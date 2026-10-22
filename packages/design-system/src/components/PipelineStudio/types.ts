import type {
	PipelineFlowData,
	PipelineFlowIssue,
} from "../PipelineFlow/types";

/** The shapes below mirror the host's pipeline studio snapshot; the DesignSystem does not import host code. */
export type PipelineStudioIssue = PipelineFlowIssue;

export type PipelineStudioWorkData = {
	workRef: string;
	title: string;
	/** Draft revision; handed back by apply and publish. */
	revision: number;
	/** The canonical text of the draft; "" when empty. */
	source: string;
	rejected: {
		title: string;
		text: string;
		issues: Array<{ path: string; rule: string }>;
		fixes: string[];
	} | null;
	issues: PipelineStudioIssue[];
	flow: PipelineFlowData | null;
	tests: Array<{ index: number; utterance: string }>;
	published: {
		toolchainRevisionId: string;
		functionName: string;
		revision: number;
	} | null;
	dirty: boolean;
	/** A specialist turn is running: apply and publish are unavailable. */
	busy: boolean;
};

/** What the last change touched in `source` (a line diff against the revision before). */
export type PipelineSourceDiff = {
	/** Per line of the current text: true when the line is new or changed. */
	changed: boolean[];
	/** Lines of the previous text that are gone; `at` is the current line they stood before. */
	removed: Array<{ at: number; lines: string[] }>;
};

type Refused = {
	ok: false;
	issues: Array<{ pointer: string; rule: string }>;
};
type Unavailable = { ok: false; code: string };

export type PipelineStudioProbeResult =
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
	| Refused
	| Unavailable;
export type PipelineStudioSelectionResult =
	| {
			ok: true;
			chosen: string | null;
			matched: boolean;
			next: string | null;
			inputs: Record<string, unknown> | null;
			code: string | null;
	  }
	| Refused
	| Unavailable;
export type PipelineStudioFixtureResult =
	| {
			ok: true;
			outcome: {
				passed: boolean;
				steps: Array<{
					id: string;
					request?: string;
					arguments?: unknown;
					materials?: Array<{
						kind: "value" | "image" | "music";
						label: string;
						value: unknown;
					}>;
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
	| Refused;

export type PipelineStudioTrialData =
	| {
			kind: "probe";
			query: string;
			pending: boolean;
			result: PipelineStudioProbeResult | null;
	  }
	| {
			kind: "select";
			utterance: string;
			pending: boolean;
			result: PipelineStudioSelectionResult | null;
	  }
	| {
			kind: "fixture";
			test: number;
			pending: boolean;
			result: PipelineStudioFixtureResult | null;
	  };
