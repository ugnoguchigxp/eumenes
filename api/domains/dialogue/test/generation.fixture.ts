import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { waitFor } from "../../../infrastructure/wait-for";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import { inputMessages } from "../../../infrastructure/model-input";
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
	MemoryTargetPort,
	StewardPort,
	WorldContextPort,
} from "../contracts";
import type { ImagePort } from "../contracts/image";
import type { MusicPort } from "../contracts/music";
import type {
	QueryVector,
	ToolchainRoutingPort,
} from "../contracts/toolchains";
import type { ChatMessage } from "../service/context";
import type { ResourceAccess } from "../service/resource-ledger";
import { testConversationAgent } from "./conversation-agent.fixture";
import { openDialogueStore } from "./store.fixture";
import { conversationSteps, sectionLines } from "./conversation-steps.fixture";
export { sectionLines } from "./conversation-steps.fixture";

/** The user's words the last message of a call answers (its `## User` section). */
export const userOf = (call: Call) =>
	sectionLines(call.messages.at(-1)!.content, "User").join("\n");

/** One model call as the fake saw it. */
export type Call = {
	messages: ChatMessage[];
	tools: string[];
	toolDefinitions?: unknown;
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

type Assignment = Parameters<NonNullable<AgencyLayerPort["assign"]>>[0];

/** An agency port that gives only what a test reads of it (the rest of the port is the test's to leave out). */
export const agencyWith = (port: Partial<AgencyLayerPort>) =>
	port as AgencyLayerPort;

/** The agency's assignment port: accepts what is handed to it and keeps it, or does not serve the conversation. */
export function agencyOf(serves = true) {
	const assigned: Assignment[] = [];
	const agency = {
		servesRepliesInTransaction: () => serves,
		assign: (input: Assignment) => {
			assigned.push(input);
			return { status: "accepted" as const, id: `a${assigned.length}` };
		},
	} as unknown as AgencyLayerPort;
	return { agency, assigned };
}

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

export type SetupOptions = {
	debugDiagnostics?: Parameters<
		typeof createDialogueService
	>[0]["debugDiagnostics"];
	debugInference?: Pick<
		InferencePort,
		"captureInTransaction" | "executeRequest"
	>;
	screenInTransaction?: ToolchainRoutingPort["screenInTransaction"];
	externalOutput?: Parameters<
		typeof createDialogueService
	>[0]["externalOutput"];
	extraMigrations?: import("../../../infrastructure/sqlite").Migration[];
	/** Cards the catalog lists (default: image and instant). */
	cards?: ToolchainCard[];
	/** Ordered search results for tests that replace an offer. The catalog remains available. */
	searches?: string[][];
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
	/** Resolves the target of a memory request that names no short reference (default: a recording port; null: none). */
	memoryTargets?: MemoryTargetPort | null;
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
		instantAnswer: "東京は12時です。" as string | null,
		stewardRequests: [] as Array<
			Parameters<StewardPort["requestInTransaction"]>[1]
		>,
		/** The forgets the steward's inbox marked excluded, by request id. */
		excluded: [] as Array<Parameters<StewardPort["excludedInTransaction"]>[1]>,
		/** Told of each forget the steward's inbox marked excluded (the steward's closure delete starts at once). */
		onExcluded: undefined as
			| ((
					db: Database,
					input: Parameters<StewardPort["excludedInTransaction"]>[1],
			  ) => void)
			| undefined,
		/** What the steward kept of the requests that named no short reference, and whether a forget of them is pending. */
		keptTargets: [] as Array<
			Parameters<StewardPort["targetRequestInTransaction"]>[1]
		>,
		pendingForget: false,
		/** The requests the agency could not settle (the next generation tells the user once). */
		unresolved: [] as Array<{ id: string; what: string }>,
		/** The corrections, forgets and suppressions that named no short reference (the agency resolves them). */
		targetRequests: [] as Array<
			Parameters<MemoryTargetPort["requestInTransaction"]>[1]
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
		/** The settings each run captured, by purpose, as the run took them. */
		captures: [] as Array<{
			subject: string;
			purpose: string;
			snapshot: unknown;
		}>,
	};
	const captured = new Map<string, unknown>();
	const accepted = new Set<string>();
	const acceptedAttempts = new Set<string>();
	const finishedAttempts = new Map<string, "succeeded" | "failed">();
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
	const nextModelStep = conversationSteps(state.steps, cards);
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		requestFor: (_db: unknown, runId: string) =>
			options.settings && !captured.has(runId) ? null : `req:${runId}`,
		...(options.settings
			? {
					snapshotInTransaction: () => ({
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
					// Without saved settings use the persona defaults.
					snapshotInTransaction: () => ({
						general: { agentName: "", userName: "", persona: "butler" },
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
		acceptInTransaction: (_db: unknown, result: Receipt) => {
			if (state.acceptAllowed && options.debugDiagnostics)
				acceptedAttempts.add(result.attemptId);
			return state.acceptAllowed;
		},
		usageOfInTransaction: (_db: unknown, result: Receipt) => {
			const status = finishedAttempts.get(result.attemptId);
			return status
				? { status, accepted: acceptedAttempts.has(result.attemptId) ? 1 : 0 }
				: null;
		},
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
				toolDefinitions: tools,
				...(session ? { session } : {}),
			});
			// The model's answer is fixed when the call is made; the gate only holds its delivery.
			const step = nextModelStep(requestId, messages, !!session?.outputSchema);
			if (!step) throw new Error("fixture_step_missing");
			const result = receipt(requestId, step);
			session?.observeInput?.({
				inferenceId: requestId,
				attemptId: result.attemptId,
				input: { boundary: "larm", messages: inputMessages(messages), tools },
			});
			if (state.gate) await state.gate;
			signal.throwIfAborted();
			if (session?.observeInput)
				finishedAttempts.set(
					result.attemptId,
					step.fail ? "failed" : "succeeded",
				);
			if (step.fail) throw new Error(step.fail);
			if (step.text) delta?.(step.text);
			return result;
		},
		...options.debugInference,
	} as unknown as InferencePort;
	const cardOf = (revisionId: string) =>
		cards.find((c) => c.revisionId === revisionId);
	const runtimeOf = (revisionId: string): ToolchainRuntimeMeta =>
		({ execution: cardOf(revisionId)?.execution }) as ToolchainRuntimeMeta;
	const toolchains = {
		screenInTransaction: options.screenInTransaction,
		embedQuery: async () => state.vector,
		routeInTransaction: (_db: unknown, input: { ids?: readonly string[] }) => {
			const ids = input.ids ?? options.searches?.[state.searchSlots.length];
			state.searchSlots.push(input.ids);
			return {
				cards: ids ? cards.filter((c) => ids.includes(c.id)) : cards,
				past: [],
				retrieval: "fts",
			};
		},
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
		commandSetInTransaction: () => {
			throw new Error("unexpected_command");
		},
	} as unknown as ToolchainRoutingPort;
	// The conversation only needs to know the image service is there; its work starts as an assignment.
	const image: ImagePort = {};
	const music: MusicPort | undefined = options.music ? {} : undefined;
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
					excludedInTransaction: (db, input) => {
						state.excluded.push(input);
						state.onExcluded?.(db, input);
						return true;
					},
					targetRequestInTransaction: (_db, input) => {
						state.keptTargets.push(input);
						if (input.request.kind === "forget") state.pendingForget = true;
					},
					hasPendingForgetInTransaction: () => state.pendingForget,
					takeUnresolvedTargetsInTransaction: () =>
						state.unresolved.splice(0, state.unresolved.length),
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
		debugDiagnostics: options.debugDiagnostics,
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
		...(options.memoryTargets === null
			? {}
			: {
					memoryTargets: options.memoryTargets ?? {
						requestInTransaction: (_db, input) => {
							state.targetRequests.push(input);
						},
					},
				}),
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
			// A handed-over run (a session) is queued again, behind its turn's job instead of its own generation.
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
		log(): ConversationEvent[] {
			return store.read((db) => continuity.events.logInTransaction(db, "main"));
		},
		fields(event: ConversationEvent) {
			return JSON.parse(event.text ?? "{}") as Record<string, unknown>;
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
