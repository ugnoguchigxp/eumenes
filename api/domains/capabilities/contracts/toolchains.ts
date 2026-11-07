import { z } from "zod";

/** Host budget for on-demand media startup, generation and retrieval; explicit caller limits take precedence. */
export const MEDIA_GENERATION_TIMEOUT_MS = 300 * 1000;

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
	{ kind: "none" } | { kind: "component"; component: string };

/** A redirect to the toolchain to use instead, shown to the conversation model by function name. */
export type ToolchainRedirect = { when: string; toolchainId: string };

/** What the host needs to run a toolchain. Host-owned: not stored in nor hashed into a revision. */
export type ToolchainRuntimeMeta = {
	/** Declared effect of a host-native execution contract; absent requires an operation-level grant. */
	autonomy?: "read" | "create";
	/**
	 * research: an agent-runtime worker with the package's profile, SKILL and tools.
	 * command: a command sub-agent turns the request into one typed operation of the package.
	 * music-create / music-playback: the music domain's own planner runs the package.
	 * session: the conversation hands over to the package's specialist for several direct turns.
	 * instant: the first round's function call carries the arguments and the adapter's sentence is the answer.
	 * pipeline: the request is planned through the imported short contract and existing parent runtime.
	 * read: one of the conversation's read tools (no toolchain): the host reads, and the talk turn tells it.
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
		| "excalidraw"
		| "read";
	/** Runtime availability the host checks before offering the toolchain. */
	requires?: "object-recognition" | "music" | "image" | "excalidraw" | "world";
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
	/** The least impact the toolchain's work has (section 6.7); absent when its definition declares none. */
	minImpact?: import("./index").ToolchainImpact;
	/** A general toolchain (its definition's `general`): offered in its own slot, after a dedicated one that fits. */
	general?: true;
	/** The resource kinds this toolchain's results create (registered `resource-kind` items); absent when none. */
	produces?: string[];
	/** Only redirects to toolchains active on this host; the caller drops ones it does not offer. */
	redirects: Array<ToolchainRedirect & { functionName: string }>;
	/** A read tool only (execution "read"): the JSON Schema (flat object) of its arguments. */
	read?: { parameters: Record<string, unknown> };
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

/** The longest description a router criterion carries (the LARM request prompt §2.2). */
export const ROUTER_PASSAGE_CHARS = 300;
/**
 * A toolchain's (or a read tool's) description as the router reads it (spec toolchain-router-redesign 2026-11-01
 * §3.2): its name and summary, and the first two use cases. The kind (dedicated, pipeline, general) is not written:
 * the router's calibration takes it.
 */
export function routerPassage(d: {
	title: string;
	summary: string;
	useWhen?: readonly string[];
}): string {
	const uses = (d.useWhen ?? []).slice(0, 2);
	const text = `${d.title}: ${d.summary}${uses.length ? `（${uses.join("／")}）` : ""}`;
	return text.length > ROUTER_PASSAGE_CHARS
		? text.slice(0, ROUTER_PASSAGE_CHARS)
		: text;
}
