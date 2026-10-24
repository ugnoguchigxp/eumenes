import { join } from "node:path";
import { rmSync } from "node:fs";
import { waitFor } from "../../../infrastructure/wait-for";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
import type { ToolchainCard, ToolchainRuntimeMeta } from "../../capabilities";
import {
	createContinuityService,
	type ConversationEvent,
} from "../../continuity";
import { createConversationService } from "../../conversation";
import type { InferencePort, Receipt } from "../../inference";
import { createMemoryService, type MemoryService } from "../../memory";
import { createQueue } from "../../queue";
import { createDialogueService } from "..";
import type {
	AgencyLayerPort,
	GoalsLayerPort,
	StewardPort,
	WorldContextPort,
} from "../contracts";
import type { ImagePort } from "../contracts/image";
import type { MusicPort } from "../contracts/music";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import type { ChatMessage } from "../service/context";
import { openDialogueStore } from "./store.fixture";

/** One model call as the fake saw it. */
export type Call = {
	messages: ChatMessage[];
	tools: string[];
};

/** What the fake model answers to one call: speech, tool calls, or both. */
export type Step = {
	text?: string;
	calls?: Array<{ name: string; args: Record<string, unknown> }>;
};

/** The analysis of a request answered from hand. */
export const CHAT = {
	kind: "chat",
	freshness: "not_live",
	impact: "none",
	approved: false,
} as const;
export const respond = (args: Record<string, unknown> = {}) => ({
	name: "respond",
	args: { ...CHAT, ...args },
});

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
	/** Cards the catalog lists (default: image and instant). */
	cards?: ToolchainCard[];
	/** Offer the music port (the music toolchain is then available). */
	music?: boolean;
	/** Real memory service (its journal in the test directory). */
	memory?: boolean;
	goals?: GoalsLayerPort;
	agency?: AgencyLayerPort;
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
};

/** A real store, queue, continuity and dialogue with a scripted model, a fake toolchain catalog and image port. */
export async function setup(options: SetupOptions = {}) {
	const { dir, store } = openDialogueStore("eumenes-generation-");
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
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
	};
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
		requestFor: (_db: unknown, runId: string) => `req:${runId}`,
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
			delta: (text: string) => void,
			_preparation: unknown,
			tools: Array<{ function: { name: string } }> | undefined,
		) => {
			state.calls.push({
				messages: messages.map((m) => ({ ...m })),
				tools: (tools ?? []).map((t) => t.function.name),
			});
			// The model's answer is fixed when the call is made; the gate only holds its delivery.
			const step = state.steps.shift();
			if (!step) throw new Error("fixture_step_missing");
			if (state.gate) await state.gate;
			signal.throwIfAborted();
			if (step.text) delta(step.text);
			return receipt(requestId, step);
		},
	} as unknown as InferencePort;
	const cardOf = (revisionId: string) =>
		cards.find((c) => c.revisionId === revisionId);
	const runtimeOf = (revisionId: string): ToolchainRuntimeMeta =>
		({ execution: cardOf(revisionId)?.execution }) as ToolchainRuntimeMeta;
	const toolchains = {
		embedQuery: async () => undefined,
		routeInTransaction: (
			_db: unknown,
			input: { excludeRevisionIds?: ReadonlySet<string> },
		) => ({
			cards: cards.filter((c) => !input.excludeRevisionIds?.has(c.revisionId)),
			past: [],
			retrieval: "fts",
		}),
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
		store,
		conversation,
		larm,
		queue,
		clock,
		continuity,
		toolchains,
		image,
		...(music ? { music } : {}),
		...(steward ? { steward } : {}),
		...(memory ? { memory } : {}),
		...(options.goals ? { goals: options.goals } : {}),
		...(options.agency ? { agency: options.agency } : {}),
		...(options.worldContext ? { worldContext: options.worldContext } : {}),
		...(options.agents ? { agents: options.agents as never } : {}),
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
		active() {
			return store.read((db) =>
				continuity.events.activeInTransaction(db, "main"),
			);
		},
		async close() {
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export type Harness = Awaited<ReturnType<typeof setup>>;
