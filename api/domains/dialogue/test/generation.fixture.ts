import { join } from "node:path";
import {
	BEST_V2_FEATURES,
	BEST_V2_FORMAT,
	BEST_V2_MEMORY_FORMAT,
	loadBestV2,
	type BestV2Params,
} from "eumenes_router";
import type { RouterCard } from "eumenes_router/sqlite";
import type { RouteAnswer, RouteInput } from "../../inference/contracts";
import { rmSync } from "node:fs";
import { waitFor } from "../../../infrastructure/wait-for";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import type { ToolchainCard, ToolchainRuntimeMeta } from "../../capabilities";
import {
	createContinuityService,
	type ConversationEvent,
} from "../../continuity";
import { createConversationService } from "../../conversation";
import type { CallSession, InferencePort, Receipt } from "../../inference";
import { createMemoryService, type MemoryService } from "../../memory";
import { createQueue } from "../../queue";
import { createDialogueService } from "..";
import type {
	AgencyLayerPort,
	ConversationAgentPort,
	StewardPort,
	WorldContextPort,
} from "../contracts";
import type { ImagePort } from "../contracts/image";
import type { MusicPort } from "../contracts/music";
import type {
	QueryVector,
	ToolchainRoutingPort,
} from "../contracts/toolchains";
import type { NearFeedback, RouterTraceRecord } from "../../toolchain-history";
import type { ChatMessage } from "../service/context";
import type { ResourceAccess } from "../service/resource-ledger";
import { testConversationAgent } from "./conversation-agent.fixture";
import { openDialogueStore } from "./store.fixture";

/**
 * The lines of one `## ` section of a message (`## State`, `## User`, `## Memory`…), without its heading; empty when
 * the message has none.
 */
export function sectionLines(content: string, heading: string): string[] {
	const open = `## ${heading}\n`;
	const at = content.startsWith(open) ? 0 : content.indexOf(`\n${open}`);
	if (at < 0) return [];
	const start = content.indexOf(open, at) + open.length;
	const next = content.indexOf("\n\n## ", start);
	return content
		.slice(start, next < 0 ? undefined : next)
		.split("\n")
		.filter((line) => line !== "");
}

/** The user's words the last message of a call answers (its `## User` section). */
export const userOf = (call: Call) =>
	sectionLines(call.messages.at(-1)!.content, "User").join("\n");

/** One model call as the fake saw it. */
export type Call = {
	messages: ChatMessage[];
	tools: string[];
	/** The session the call carried (its output limit and reasoning). */
	session?: CallSession;
};

/** What the fake model answers to one call: plain speech, native tool calls, or both. */
export type Step = {
	text?: string;
	calls?: Array<{ name: string; args: Record<string, unknown> }>;
	/** The call fails with this code instead (`chat_output_empty`: it ended cleanly with nothing in it). */
	fail?: string;
};

/** A routed turn's choice, as the model answers it (a call held to a schema answers JSON text). */
export const choice = (value: Record<string, unknown>): Step => ({
	text: JSON.stringify(value),
});

/**
 * The steps a plain reply takes on the routed turn when no judge ran: the request turn's choice (`none`), then the
 * talk call that says `text`.
 */
export const reply = (text: string): Step[] => [
	choice({ choice: "none" }),
	{ text },
];

export const IMAGE: ToolchainCard = {
	revisionId: "toolchain:fake.image@1",
	id: "fake.image",
	functionName: "fake_image",
	title: "画像",
	summary: "画像を作る",
	useWhen: ["絵を描く"],
	execution: "image",
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};
export const MUSIC: ToolchainCard = {
	revisionId: "toolchain:fake.music@1",
	id: "fake.music",
	functionName: "fake_music",
	title: "作曲",
	summary: "曲を作る",
	useWhen: ["曲を作る"],
	execution: "music-create",
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};
export const RESEARCH: ToolchainCard = {
	revisionId: "toolchain:fake.research@1",
	id: "fake.research",
	functionName: "fake_research",
	title: "調べ物",
	summary: "Webで調べる",
	useWhen: ["調べて"],
	execution: "research",
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};
export const INSTANT: ToolchainCard = {
	revisionId: "toolchain:fake.clock@1",
	id: "fake.clock",
	functionName: "fake_clock",
	title: "時計",
	summary: "世界の時刻を答える",
	useWhen: ["時刻"],
	execution: "instant",
	redirects: [],
	instant: {
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		},
		parse: (args) =>
			typeof (args as { city?: unknown }).city === "string"
				? { ok: true, value: args as Record<string, unknown> }
				: { ok: false },
	},
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
};

const DEFAULT_CARDS = [IMAGE, INSTANT];

/** The router package's embedding space in the fixture: every text and passage is the same vector. */
export const ROUTER_SPACE = {
	modelId: "m",
	revision: "1",
	artifactDigest: "d",
	dimension: 2,
};
const featureWeight = (
	weights: Partial<Record<(typeof BEST_V2_FEATURES)[number], number>>,
) => BEST_V2_FEATURES.map((f) => weights[f] ?? 0);
/**
 * A best-v2 whose probability is the context judgment's score alone, with the conversation at a fixed level:
 * σ(10·score − 4) for a candidate scored, σ(0) = 0.5 for the conversation. A score of 0.95 is sure (≈1.0), 0.45 is
 * the top but not sure (≈0.62, within the gate of the conversation), 0 is nothing (≈0.02).
 */
const ROUTER_PARAMS: BestV2Params = {
	format: BEST_V2_FORMAT,
	version: "fixture",
	source: "fixture",
	features: [...BEST_V2_FEATURES],
	ranker: {
		mean: featureWeight({}),
		scale: BEST_V2_FEATURES.map(() => 1),
		coef: featureWeight({ rr: 10, is_conv: 4 }),
		intercept: -4,
	},
	gate: { deferBelow: 0.2 },
	fuse: { weight: 2, conversation: 0.18, top: 8 },
	extra: { tools: 4 },
	knn: { neighbors: 1, dimension: 2 },
};
const routerModel = (deferBelow: number) =>
	loadBestV2(
		{ ...ROUTER_PARAMS, gate: { deferBelow } },
		{
			format: BEST_V2_MEMORY_FORMAT,
			source: "fixture",
			dimension: 2,
			labels: ["conversation.respond"],
			vectors: btoa(
				String.fromCharCode(...new Uint8Array(new Float32Array([1, 0]).buffer)),
			),
		},
	);
export const ROUTER_MODEL = routerModel(ROUTER_PARAMS.gate.deferBelow);
export const DIRECT_ROUTER_MODEL = routerModel(0);
/** The router as the fixtures save it: a profile, the package's `route` entry and the product's lines. */
export const FIXTURE_ROUTER = {
	profile: "router-fixture-profile",
	entry: "route" as const,
	structureResourceId: null,
	structureTimeoutMs: 8000,
	timeoutMs: 2000,
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};

/**
 * The criteria a scripted step names as the model's choice used to (`choice({...})`), and the step the fill call
 * answers with when the choice carried fields. A step that is no choice names nothing.
 */
function pickedBy(step: Step | undefined): {
	ids: string[];
	next?: Step;
} | null {
	if (!step?.text || step.fail || step.calls) return null;
	let v: Record<string, unknown>;
	try {
		v = JSON.parse(step.text) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!v || typeof v !== "object" || typeof v.choice !== "string") return null;
	const { choice } = v;
	if (choice === "ask")
		return {
			ids: [],
			...(typeof v.say === "string" ? { next: { text: v.say } } : {}),
		};
	const ids = idsOfChoice(v as Record<string, unknown> & { choice: string });
	const { say: _say, ...fields } = v;
	return {
		ids,
		// The fields the choice carried are the fill's answer (a memory request, inputs, a saved target).
		...(ids.length === 1 &&
		ids[0] === choice &&
		(choice === "memory.request" || "inputs" in v || "target" in v)
			? { next: { text: JSON.stringify(fields) } }
			: {}),
	};
}

/**
 * The router's criteria a choice the model used to make names (`choice({...})` of the old choice call): a toolchain,
 * a read tool or a memory request by its id, a confirmation's yes or no, a question's answer, an operation on a work,
 * the word that lets unsaved work go. `none` and `ask` name nothing.
 */
export function idsOfChoice(
	v: Record<string, unknown> & { choice: string },
): string[] {
	const { choice } = v;
	if (choice === "none" || choice === "ask") return [];
	if (choice === "approve" || choice === "decline")
		return [`${String(v.confirmation)}.${choice}`];
	if (choice === "answer") return [`${String(v.todo)}.answer`];
	if (/^t\d+$/.test(choice) && typeof v.operation === "string")
		return [`${choice}.${v.operation}`];
	// The user's word that the unsaved work may go is the host's own candidate now.
	if (v.resolveUnsaved === "discard") return ["switch.discard"];
	return [choice];
}

/**
 * LARM's context judgment of the fixtures: the next scripted step, when it is a choice, makes its candidate a sure
 * top (0.95, with `ROUTER_MODEL`); anything else scores nothing, so the conversation leads.
 */
export function routeBySteps(steps: Step[], routes?: RouteInput[]) {
	return async (input: RouteInput): Promise<RouteAnswer> => {
		routes?.push(input);
		const picked = pickedBy(steps[0]);
		if (picked) {
			steps.shift();
			if (picked.next) steps.unshift(picked.next);
		}
		const names = input.criteria.map((c) => c.name);
		const scores = Object.fromEntries(
			names.map((name) => [name, picked?.ids.includes(name) ? 0.95 : 0]),
		);
		return {
			choice: names.find((name) => scores[name]) ?? names[0]!,
			probabilities: Object.fromEntries(
				names.map((name) => [name, 1 / names.length]),
			),
			scores,
			model: "router-fixture-model",
			headRevision: "head-1",
			calibrationRevision: "cal-1",
		};
	};
}

/** The fixture's toolchains as the router package's synced cards, with the conversation's and a memory request's. */
export function routerCards(cards: readonly ToolchainCard[]): RouterCard[] {
	const card = (
		id: string,
		kind: RouterCard["kind"],
		title: string,
		summary: string,
		useWhen: readonly string[] = [],
		impact: RouterCard["impact"] = "none",
	): RouterCard => ({
		id,
		revision: "1",
		kind,
		title,
		summary,
		useWhen: [...useWhen],
		examples: [],
		impact,
		passages: [new Float32Array([1, 0])],
	});
	return [
		card("conversation.respond", "general", "conversation.respond", "会話"),
		card("memory.request", "general", "memory.request", "記憶の依頼"),
		...cards.map((c) =>
			card(
				c.id,
				c.execution === "read"
					? "read"
					: c.execution === "pipeline"
						? "pipeline"
						: c.general
							? "general"
							: "dedicated",
				c.title,
				c.summary,
				c.useWhen,
				c.minImpact ?? "none",
			),
		),
	];
}

export type SetupOptions = {
	externalOutput?: Parameters<
		typeof createDialogueService
	>[0]["externalOutput"];
	extraMigrations?: import("../../../infrastructure/sqlite").Migration[];
	/** Cards the catalog lists (default: image and instant). */
	cards?: ToolchainCard[];
	routerModel?: typeof ROUTER_MODEL;
	beforeRouterEmbed?: (
		texts: readonly string[],
		signal: AbortSignal,
	) => Promise<void>;
	/** Offer the music port (the music toolchain is then available). */
	music?: boolean;
	/** Real memory service (its journal in the test directory). */
	memory?: boolean;
	agency?: AgencyLayerPort;
	/** The conversation agent (default: the agency's own reply loop, see conversation-agent.fixture.ts). */
	conversationAgent?: ConversationAgentPort;
	worldContext?: WorldContextPort;
	/** Queue limits (the queue's own options). */
	queue?: Parameters<typeof createQueue>[1];
	/** Start the queue at once (default true). */
	autoStart?: boolean;
	/** The steward receives requests and run ends (default: a recording steward). */
	steward?: StewardPort | null;
	/** Revisions the catalog lists whose card cannot be rebuilt (the pinned submit then fails). */
	unbuildable?: string[];
	/** The model window the run's LARM lease reports (tokens); absent: the reference window. */
	window?: number;
	/** Agent runtime for task executions (notice runs); absent: no agents. */
	agents?: unknown;
	/** The resource registry and the kinds each toolchain makes; absent: the conversation has no resources. */
	resources?: ResourceAccess;
	/** The input's shared files and the conversation's recent ones; absent: none. */
	sharedFiles?: import("../contracts/resources").SharedFilesPort;
	/**
	 * The saved settings the run captures its routes from (the snapshot a LARM lease would be taken on). Absent: the
	 * run has a LARM request from the start and no settings.
	 */
	settings?: unknown;
	/** With `settings`: the run is not captured when it is accepted, so its prepare takes the request. */
	lateCapture?: boolean;
	/** The context keeper's inference and quiet wait; absent: no keeper runs. */
	keeper?: NonNullable<Parameters<typeof createDialogueService>[0]["keeper"]>;
};

/** A real store, queue, continuity and dialogue with a scripted model, a fake toolchain catalog and image port. */
export async function setup(options: SetupOptions = {}) {
	const { dir, store } = openDialogueStore(
		"eumenes-generation-",
		options.extraMigrations,
	);
	const conversation = createConversationService(store);
	const continuity = createContinuityService();
	const cards = options.cards ?? DEFAULT_CARDS;
	const state = {
		offsetMs: 0,
		steps: [] as Step[],
		calls: [] as Call[],
		receiptAllowed: true,
		/** Whether adoption accepts the receipt (permission still held). */
		acceptAllowed: true,
		/** When set, each model call waits for it before answering (to observe a run in flight). */
		gate: null as Promise<void> | null,
		images: new Map<string, unknown>(),
		instantAnswer: "東京は12時です。" as string | null,
		stewardRequests: [] as Array<
			Parameters<StewardPort["requestInTransaction"]>[1]
		>,
		runEnds: [] as Array<Parameters<StewardPort["runEndedInTransaction"]>[1]>,
		selections: [] as Array<Record<string, unknown>>,
		/** The context policies set on the run's requests, as `requestId:policy`. */
		policies: [] as string[],
		settled: [] as Array<{ runId: string; outcome: string }>,
		/** The vector the search embeds a query to (absent: the embedding is unavailable). */
		vector: undefined as QueryVector | undefined,
		/** The ids each offer of the catalog was asked for (absent: the choice call's own search). */
		searchSlots: [] as Array<readonly string[] | undefined>,
		/** What the router's context judgment was asked, turn by turn. */
		routerAsked: [] as RouteInput[],
		/** The texts the router package embedded; a failure of the embedding with this code. */
		routerEmbeds: [] as string[],
		routerEmbedFails: null as string | null,
		/** best-v2's memory was imported (without it the router decides nothing). */
		routerMemory: true,
		/** The router's traces as the store was asked to keep them, and the work each was linked to. */
		traces: [] as RouterTraceRecord[],
		traceModes: [] as string[],
		/** The corrections the user made (the store's active rows); the nearest are read by their similarity. */
		corrections: [] as NearFeedback[],
		feedback: [] as Array<Record<string, unknown>>,
		/** The states the store was asked to put corrections in (a conflict found while routing). */
		feedbackStates: [] as Array<{ id: string; state: string }>,
		/** The router's read of the previous trace fails. */
		failRouterRead: false,
		/** The settings each run captured, by purpose, as the run took them. */
		captures: [] as Array<{
			subject: string;
			purpose: string;
			snapshot: unknown;
		}>,
	};
	const captured = new Map<string, unknown>();
	const accepted = new Set<string>();
	const clock = () => new Date(Date.now() + state.offsetMs).toISOString();
	const receipt = (requestId: string, step: Step): Receipt => ({
		requestId,
		attemptId: crypto.randomUUID(),
		value: step.text ?? "",
		toolCalls: (step.calls ?? []).map((call): NativeToolCall => ({
			id: crypto.randomUUID(),
			name: call.name,
			arguments: JSON.stringify(call.args),
		})),
	});
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		// The router decides every utterance turn: its context judgment reads the scripted steps.
		route: routeBySteps(state.steps, state.routerAsked),
		requestFor: (_db: unknown, runId: string) =>
			options.settings && !captured.has(runId) ? null : `req:${runId}`,
		...(options.settings
			? {
					snapshotInTransaction: () => ({
						router: FIXTURE_ROUTER,
						...structuredClone(options.settings as object),
					}),
					captureInTransaction: (
						_db: unknown,
						subject: string,
						purpose: string,
						_deadline: number,
						snapshot: unknown,
					) => {
						// A late capture leaves the accept-time one out: the run's request is then taken at prepare.
						if (options.lateCapture && !accepted.has(subject)) {
							accepted.add(subject);
							return `req:${subject}`;
						}
						// A capture without a snapshot takes the saved settings as they are.
						const taken = snapshot ?? structuredClone(options.settings);
						captured.set(subject, taken);
						state.captures.push({ subject, purpose, snapshot: taken });
						return `req:${subject}`;
					},
					snapshotFor: (_db: unknown, subject: string) =>
						captured.get(subject) ?? null,
				}
			: {
					// Without saved settings the fixture still has the router (and the persona's defaults).
					snapshotInTransaction: () => ({
						general: { agentName: "", userName: "", persona: "butler" },
						router: FIXTURE_ROUTER,
					}),
				}),
		llmContextWindowInTransaction: () => options.window,
		setContextPolicyInTransaction: (
			_db: unknown,
			requestId: string,
			policy: string,
		) => {
			state.policies.push(`${requestId}:${policy}`);
		},
		validateReceiptInTransaction: () => state.receiptAllowed,
		acceptInTransaction: () => state.acceptAllowed,
		answer: async () => {
			throw new Error("unexpected_answer");
		},
		executeStream: async (
			requestId: string,
			messages: ChatMessage[],
			signal: AbortSignal,
			/** Absent for a silent call (a routed turn's choice). */
			delta: ((text: string) => void) | undefined,
			_preparation: unknown,
			tools: Array<{ function: { name: string } }> | undefined,
			session?: CallSession,
		) => {
			state.calls.push({
				messages: messages.map((m) => ({ ...m })),
				tools: (tools ?? []).map((t) => t.function.name),
				...(session ? { session } : {}),
			});
			// The model's answer is fixed when the call is made; the gate only holds its delivery.
			const step = state.steps.shift();
			if (!step) throw new Error("fixture_step_missing");
			if (state.gate) await state.gate;
			signal.throwIfAborted();
			if (step.fail) throw new Error(step.fail);
			if (step.text) delta?.(step.text);
			return receipt(requestId, step);
		},
	} as unknown as InferencePort;
	const cardOf = (revisionId: string) =>
		cards.find((c) => c.revisionId === revisionId);
	const runtimeOf = (revisionId: string): ToolchainRuntimeMeta =>
		({ execution: cardOf(revisionId)?.execution }) as ToolchainRuntimeMeta;
	const toolchains = {
		embedQuery: async () => state.vector,
		routeInTransaction: (_db: unknown, input: { ids?: readonly string[] }) => {
			state.searchSlots.push(input.ids);
			return {
				cards: input.ids
					? cards.filter((c) => input.ids!.includes(c.id))
					: cards,
				past: [],
				retrieval: "fts",
			};
		},
		embedRouter: async (texts: readonly string[], signal: AbortSignal) => {
			state.routerEmbeds.push(...texts);
			await options.beforeRouterEmbed?.(texts, signal);
			if (state.routerEmbedFails) throw new Error(state.routerEmbedFails);
			return { space: ROUTER_SPACE, vectors: texts.map(() => [1, 0]) };
		},
		routerCardsInTransaction: () => routerCards(cards),
		routerLexicalInTransaction: () => new Map(),
		routerModelInTransaction: () =>
			state.routerMemory ? (options.routerModel ?? ROUTER_MODEL) : null,
		titlesInTransaction: (_db: unknown, ids: readonly string[]) =>
			new Map(
				cards.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.title]),
			),
		recordRouterTraceInTransaction: (
			_db: unknown,
			input: Parameters<
				NonNullable<ToolchainRoutingPort["recordRouterTraceInTransaction"]>
			>[1],
		) => {
			state.traceModes.push(input.trace.mode);
			state.traces = state.traces.filter((t) => t.runId !== input.runId);
			state.traces.push({
				runId: input.runId,
				conversationId: input.conversationId,
				messageId: input.messageId,
				messageIds: [...input.messageIds],
				text: input.text,
				query: input.query,
				decided: input.trace.decided,
				workId: null,
				set: input.trace.set,
				createdAt: Date.now() + state.offsetMs,
				row: input.trace.row,
				mode: input.trace.mode,
				// What the fake keeps of the trace beyond the record: the failure.
				...({ error: input.trace.error } as object),
			});
		},
		linkRouterWorkInTransaction: (
			_db: unknown,
			runId: string,
			workId: string,
		) => {
			const trace = state.traces.find((t) => t.runId === runId);
			if (trace) trace.workId = workId;
		},
		latestRouterTraceInTransaction: (
			_db: unknown,
			input: { conversationId: string; since: number },
		) => {
			if (state.failRouterRead) throw new Error("fixture_router_read_failed");
			return (
				[...state.traces]
					.reverse()
					.find(
						(t) =>
							t.conversationId === input.conversationId &&
							t.createdAt >= input.since,
					) ?? null
			);
		},
		setRouterFeedbackStateInTransaction: (
			_db: unknown,
			id: string,
			state_: string,
		) => {
			state.feedbackStates.push({ id, state: state_ });
			return true;
		},
		recordRouterFeedbackInTransaction: (
			_db: unknown,
			input: Record<string, unknown>,
		) => {
			state.feedback.push(input);
			return "feedback";
		},
		nearRouterFeedbackInTransaction: (
			_db: unknown,
			input: { threshold: number },
		) => state.corrections.filter((row) => row.similarity >= input.threshold),
		cardInTransaction: (_db: unknown, revisionId: string) =>
			options.unbuildable?.includes(revisionId)
				? undefined
				: cardOf(revisionId),
		resolveInTransaction: (_db: unknown, revisionId: string) => {
			if (!cardOf(revisionId)) throw new Error("toolchain_unavailable");
			return {
				toolchain: {},
				packageRevisionId: "package:fake@1",
				runtime: runtimeOf(revisionId),
			};
		},
		catalogInTransaction: () =>
			cards.map((c) => ({
				id: c.id,
				revisionId: c.revisionId,
				runtime: {
					...runtimeOf(c.revisionId),
					...(c.id === IMAGE.id
						? { requires: "image" }
						: c.id === MUSIC.id
							? { requires: "music" }
							: { binding: { available: true } }),
				},
			})),
		instantInTransaction: (_db: unknown, revisionId: string) =>
			revisionId === INSTANT.revisionId
				? {
						run: async () =>
							state.instantAnswer
								? { ok: true as const, answer: state.instantAnswer }
								: { ok: false as const, code: "lookup_failed" },
						fallback: null,
					}
				: undefined,
		recordSelectionInTransaction: (
			_db: unknown,
			input: Record<string, unknown>,
		) => {
			state.selections.push(input);
			return "selection";
		},
		settleSelectionInTransaction: (
			_db: unknown,
			runId: string,
			result: { outcome: string },
		) => {
			state.settled.push({ runId, outcome: result.outcome });
		},
		linkTaskInTransaction: () => {},
		requestOfRunInTransaction: () => undefined,
		commandSetInTransaction: () => {
			throw new Error("unexpected_command");
		},
	} as unknown as ToolchainRoutingPort;
	const image: ImagePort = {
		startInTransaction: (_db, input) => ({
			id: `image:${input.runId}`,
			jobId: `image-job:${input.runId}`,
		}),
		resultInTransaction: (_db, runId) => state.images.get(runId) ?? null,
	};
	const music = options.music
		? ({
				startInTransaction: (_db: unknown, input: { runId: string }) => ({
					id: `music:${input.runId}`,
					jobId: `music-job:${input.runId}`,
				}),
				resultInTransaction: () => null,
			} as unknown as MusicPort)
		: undefined;
	const steward: StewardPort | undefined =
		options.steward === null
			? undefined
			: (options.steward ?? {
					runEndedInTransaction: (_db, input) => {
						state.runEnds.push(input);
					},
					requestInTransaction: (_db, input) => {
						state.stewardRequests.push(input);
						return {
							id: `request:${state.stewardRequests.length}`,
							replay: false,
						};
					},
				});
	const memory: MemoryService | undefined = options.memory
		? createMemoryService(store, conversation, continuity, {
				journalPath: join(dir, "journal.jsonl"),
			})
		: undefined;
	if (memory) await memory.recover();
	const queue = createQueue(store, options.queue ?? {});
	const dialogue = createDialogueService({
		externalOutput: options.externalOutput,
		store,
		conversation,
		larm,
		queue,
		clock,
		continuity,
		conversationAgent: options.conversationAgent ?? testConversationAgent,
		toolchains,
		image,
		...(music ? { music } : {}),
		...(steward ? { steward } : {}),
		...(memory ? { memory } : {}),
		...(options.agency ? { agency: options.agency } : {}),
		...(options.worldContext ? { worldContext: options.worldContext } : {}),
		...(options.agents ? { agents: options.agents as never } : {}),
		...(options.resources
			? {
					resources: {
						...options.resources,
						...(options.sharedFiles
							? { sharedFiles: options.sharedFiles }
							: {}),
					},
				}
			: {}),
		...(options.keeper ? { keeper: options.keeper } : {}),
	});
	if (options.autoStart !== false) queue.start();
	const run = (id: string) => dialogue.get(id);
	return {
		dir,
		store,
		conversation,
		continuity,
		memory,
		queue,
		dialogue,
		larm,
		state,
		/** Starts the queue (for tests that prepare rows before the first claim). */
		start() {
			queue.start();
		},
		/** Submits a text utterance and waits for its run to reach `status`. */
		async say(
			text: string,
			status = "completed",
			extra: {
				toolchainId?: string;
				presentation?: "artifact" | "conversation";
			} = {},
		) {
			const accepted = await dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
				...extra,
			});
			// A handed-over run is queued again, behind its work's job instead of its own generation.
			await waitFor(() => {
				const now = run(accepted.id);
				return (
					now?.status === status &&
					(status !== "queued" || now.jobId !== accepted.jobId)
				);
			}).catch(() => {
				throw new Error(
					`run_not_${status}: ${JSON.stringify(run(accepted.id))}`,
				);
			});
			return run(accepted.id)!;
		},
		/** The image job finished: its result is saved and the waiting run comes back. */
		async finishImage(runId: string, result: unknown, status = "completed") {
			state.images.set(runId, result);
			await store.write((db) =>
				dialogue.finishOperationInTransaction(db, runId),
			);
			await waitFor(() => run(runId)?.status === status);
			return run(runId)!;
		},
		log(): ConversationEvent[] {
			return store.read((db) => continuity.events.logInTransaction(db, "main"));
		},
		fields(event: ConversationEvent) {
			return JSON.parse(event.text ?? "{}") as Record<string, unknown>;
		},
		todos() {
			return store.read((db) => dialogue.todosInTransaction(db, "main"));
		},
		/** The archived TODOs, newest first: finished work is archived as it finishes. */
		archived() {
			return store.read(
				(db) =>
					dialogue.todoPageInTransaction(db, "main", {
						state: "archived",
						pageIndex: 0,
						pageSize: 50,
					}).rows,
			);
		},
		/** The finished TODOs' notices, newest first, and the unread count. */
		notices() {
			return dialogue.todoNotices(50);
		},
		/** The work results the log holds (`work.result` events), in log order: what the owners reported. */
		results(): ConversationEvent[] {
			return store
				.read((db) => continuity.events.logInTransaction(db, "main"))
				.filter(
					(e) =>
						e.type === "acted" &&
						(JSON.parse(e.text ?? "{}") as Record<string, unknown>).action ===
							"work.result",
				);
		},
		async close() {
			await dialogue.close();
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export type Harness = Awaited<ReturnType<typeof setup>>;
