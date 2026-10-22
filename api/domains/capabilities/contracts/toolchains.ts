import { z } from "zod";

/** The function name the conversation model calls for one toolchain. */
export const toolchainFunctionPattern = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * The only argument any toolchain function takes. The conversation model hands over the
 * user's request; the toolchain's own sub-agent decides tools and arguments.
 */
export const toolchainRequest = z
	.object({
		request: z
			.string()
			.trim()
			.min(1)
			.max(8000)
			.describe(
				"ユーザーの依頼。対象・日時・件数・条件を原文から保持し、直前の会話で明確になった対象を補う。未指定の条件は足さない。",
			),
	})
	.strict();

/**
 * How a toolchain shows its result on screen: the web component that renders it.
 * "none" is an explicit choice, not a default.
 */
export type ToolchainArtifact =
	| { kind: "none" }
	| { kind: "component"; component: string };

/** A redirect to the toolchain to use instead, shown to the conversation model by function name. */
export type ToolchainRedirect = { when: string; toolchainId: string };

/** What the host needs to run a toolchain. Host-owned: not stored in nor hashed into a revision. */
export type ToolchainRuntimeMeta = {
	/**
	 * research: an agent-runtime worker with the package's profile, SKILL and tools.
	 * command: a command sub-agent turns the request into one typed operation of the package.
	 * music-create / music-playback: the music domain's own planner runs the package.
	 * session: the conversation hands over to the package's specialist for several direct turns.
	 * instant: the first round's function call carries the arguments and the adapter's sentence is the answer.
	 * pipeline: the first round's function call carries the inputs and the host runs the fixed steps.
	 */
	execution:
		| "research"
		| "command"
		| "session"
		| "instant"
		| "task"
		| "pipeline"
		| "music-create"
		| "music-playback"
		| "image"
		| "excalidraw";
	/** Runtime availability the host checks before offering the toolchain. */
	requires?:
		| "object-recognition"
		| "codex"
		| "timers"
		| "music"
		| "dots"
		| "image"
		| "excalidraw"
		| "world";
	/** Fixed engine for research toolchains; omitted means the current model. */
	researcher?: "codex";
	/** The research route the agent runtime keeps for its existing contracts. */
	route?: "web" | "history" | "world";
	/**
	 * Bound command toolchains (spec 2026-10-13 §5): resolved from the toolchain revision's
	 * versioned binding and the host adapter registry, never from the fixed runtime map.
	 * `available` is the adapter's availability on this host now.
	 */
	binding?: {
		bindingRevisionId: string;
		adapterRef: string;
		/** Absent for an instant binding, which has no screen. */
		artifactRevisionId?: string;
		available: boolean;
	};
};

/** One candidate toolchain offered to the conversation model. */
export type ToolchainCard = {
	/** Host-declared execution contract, exposed for the LLM to assess delegation scope. */
	execution?: ToolchainRuntimeMeta["execution"];
	revisionId: string;
	id: string;
	functionName: string;
	title: string;
	summary: string;
	useWhen: string[];
	/** Only redirects to toolchains active on this host; the caller drops ones it does not offer. */
	redirects: Array<ToolchainRedirect & { functionName: string }>;
	/**
	 * An instant-answer toolchain only (binding execution "instant"), filled by the host while it
	 * finds the candidates: the arguments its first-round function takes besides the analysis.
	 */
	instant?: {
		/** JSON Schema (flat object) of those arguments. */
		parameters: Record<string, unknown>;
		/** Check the model's arguments against that schema. */
		parse(
			args: unknown,
		): { ok: true; value: Record<string, unknown> } | { ok: false };
	};
	/**
	 * A task pipeline only (binding execution "pipeline"), filled by the host while it finds the candidates: the
	 * inputs its first-round function takes besides the analysis and the notice, each with its quote.
	 */
	pipeline?: {
		/** JSON Schema (flat object) of the inputs and their `<name>_quote`. */
		parameters: Record<string, unknown>;
		/** The steps as one line ("調べる→タイマー→曲"). */
		outline: string;
		/** Check the model's inputs against the definition and the user's request (the quotes). */
		parse(
			args: Record<string, unknown>,
			request: string,
		):
			| { ok: true; value: Record<string, unknown> }
			| { ok: false; issues: Array<{ path: string; code: string }> };
	};
	/** Ranks and scores that placed it among the candidates; recorded in the selection trace. */
	score: {
		rank: number;
		ftsRank: number | null;
		similarity: number | null;
		fromHistory: boolean;
	};
};

/** The vector space a stored embedding belongs to. */
export type VectorSpace = {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
};
