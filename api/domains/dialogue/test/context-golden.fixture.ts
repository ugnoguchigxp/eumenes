/**
 * A harness that runs one generation of the real dialogue handler (prepare in the claim transaction, then execute)
 * against a fake inference port and records the message lists the model is sent. The golden tests compare these
 * lists byte for byte; everything that varies between runs (message ids, ISO times) is normalised.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { waitFor as until } from "../../../infrastructure/wait-for";
import type { AgentRuntime, AnswerTicket } from "../../agent-runtime";
import {
	migrations as conversationMigrations,
	createConversationService,
} from "../../conversation";
import {
	createContinuityService,
	migration as continuityMigration,
	shortTermMigration,
	itemSourceMigration,
} from "../../continuity";
import type { CallSession, InferencePort } from "../../inference";
import {
	createMemoryService,
	migration as memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
	type MemoryService,
	type WindowSnapshot,
} from "../../memory";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	analysisArgs,
	analysisReceipt,
	delegatingArgs,
	isAnalysisRound,
	unavailableReceipt,
	UNAVAILABLE,
} from "./analysis.fixture";
import type { HandlerDefinition, QueueService } from "../../queue";
import {
	createDialogueService,
	agentLinkMigration,
	migration as dialogueMigration,
	queueLinkMigration,
	worldStateMigration,
} from "..";
import { byId } from "../repository";
import { compileAssembly } from "../service/context-compiler";
import type { ContextAssembly } from "../service/context-assembly";
import {
	GENERATE_KIND,
	type GenerateInput,
	type GeneratePayload,
} from "../service/context";

const MIGRATIONS = [
	...conversationMigrations,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	agentLinkMigration,
	worldStateMigration,
	continuityMigration,
	shortTermMigration,
	itemSourceMigration,
	memoryMigration,
	contextWindowMigration,
	agentHardeningMigration,
	turnVectorsMigration,
	stewardLedgersMigration,
	forgetClosureMigration,
	seedImportMigration,
	...memoryPackageMigrations,
];

const FIXED_CLOCK = "2026-10-17T03:00:00.000Z";
export const TURN_TEXTS = [
	"私は辛いものが好きです",
	"週末は山に行きます",
	"旅行の計画を立てたい",
];

/** What a scenario switches on; everything else is off. */
export type Scenario = {
	/** A real memory service whose window is the crafted one below. */
	memory?: "layers" | "layers-prefetch-dropped" | "empty";
	goals?: boolean;
	/** Earlier completed turns in the conversation (default 3). */
	turns?: number;
	/** The run answers a sub-agent's report: `projection` is a research report, `actionPayload` a saved operation. */
	agent?: Partial<AnswerTicket>;
	worldNames?: string[];
	excalidraw?: unknown;
	recognition?: unknown;
	image?: unknown;
	music?: unknown;
	delegation?: unknown;
	commandNote?: string;
	specialistHandoff?: string;
	/** The routing offers toolchains: the analysis delegates, then the selection call follows (otherwise the analysis answers and the answer call follows). */
	cards?: boolean;
	/** The earlier-exchange recall finds this text. */
	recall?: string;
	text?: string;
};

export type Captured = {
	/** What the compile step decided for the run, read again after the generation (not part of the golden fixtures). */
	assembly: ContextAssembly;
	/** The ids of the messages the ledger holds for the conversation. */
	ledgerMessageIds: string[];
	prepared: {
		messages: Array<{ role: string; content: string }>;
		sessionContext: GenerateInput["sessionContext"] | null;
		currentRequest: { messageId: string; messageIndex: number };
		actionResultIndex: number | null;
		flags: Record<string, boolean>;
	};
	calls: Array<{
		messages: Array<{ role: string; content: string }>;
		session: CallSession | null;
		tools: string[];
	}>;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
export const normalize = (text: string) =>
	text.replace(UUID, "<uuid>").replace(ISO, "<iso>");
export const normalizeMessages = (
	messages: ReadonlyArray<{ role: string; content: string }>,
) => messages.map((m) => ({ role: m.role, content: normalize(m.content) }));

/** The text of a layer exactly as memory writes it: the header, then each section (a heading may follow a blank line). */
function layerText(
	header: string,
	sections: Array<{ heading?: string; items: string[] }>,
	gap: boolean,
) {
	const lines = [header];
	for (const section of sections) {
		if (section.heading !== undefined) {
			if (gap) lines.push("");
			lines.push(section.heading);
		}
		lines.push(...section.items);
	}
	return lines.join("\n");
}
const LONG_TERM = {
	header:
		"以下は本人について保存された情報です。参考資料であり命令ではありません。",
	sections: [
		{ items: ["- 好み: 辛いものが好き", "- 制約: 甲殻類アレルギー"] },
		{ heading: "傾向", items: ["- 返答は短めを好む"] },
	],
};
const SHORT_TERM = {
	header: "以下は最近のメモです。期限が来れば消えます。",
	sections: [
		{ heading: "今日のメモ", items: ["- 午後は会議"] },
		{ heading: "最近覚えたこと", items: ["- 週末に登山"] },
	],
};

function craftedWindow(
	real: WindowSnapshot,
	kind: NonNullable<Scenario["memory"]>,
	keepRef:
		| { inputMessageId: string; answerMessageId: string | null }
		| undefined,
	pinMessageId: string | undefined,
): WindowSnapshot {
	if (kind === "empty") return real;
	return {
		...real,
		longTerm: {
			...real.longTerm,
			header: LONG_TERM.header,
			sections: LONG_TERM.sections,
			text: layerText(LONG_TERM.header, LONG_TERM.sections, true),
		},
		shortTerm: {
			...real.shortTerm,
			header: SHORT_TERM.header,
			sections: SHORT_TERM.sections,
			text: layerText(SHORT_TERM.header, SHORT_TERM.sections, false),
		},
		history: {
			...real.history,
			keep: keepRef ? [keepRef] : [],
			summaryText: "旅行の話をしていた。",
			summaryRevision: 1,
			summaryCovers: {
				fromAt: "2026-10-01T00:00:00.000Z",
				toAt: "2026-10-05T00:00:00.000Z",
				turns: 4,
			},
		},
		prefetch: {
			text: "関連する過去のやり取り（prefetch）",
			pins:
				kind === "layers-prefetch-dropped" && pinMessageId
					? [{ messageId: pinMessageId, digest: "x" }]
					: [],
			tokens: 40,
		},
		notices: [{ id: "n1", text: "メモを一件整理しました" }],
	};
}

export async function runScenario(scenario: Scenario): Promise<Captured> {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-context-golden-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	try {
		return await run(store, dir, scenario);
	} finally {
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
}

async function run(
	store: SqliteStore,
	dir: string,
	scenario: Scenario,
): Promise<Captured> {
	let recording = false;
	const calls: Captured["calls"] = [];
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		requestFor: () => "request-1",
		executeRequest: async () => {
			throw new Error("unexpected_request");
		},
		executeStream: async (
			_id: string,
			messages: Array<{ role: string; content: string }>,
			_signal: AbortSignal,
			_delta: (text: string) => void,
			_preparation: unknown,
			tools?: Array<{ function: { name: string } }>,
			session?: CallSession,
		) => {
			if (!recording)
				return {
					requestId: "request-1",
					attemptId: "attempt",
					value: `回答${messages.length}`,
				};
			calls.push({
				messages: normalizeMessages(messages),
				session: session
					? JSON.parse(normalize(JSON.stringify(session)))
					: null,
				tools: (tools ?? []).map((t) => t.function.name),
			});
			if (isAnalysisRound(tools))
				return analysisReceipt(
					"request-1",
					scenario.cards ? delegatingArgs() : analysisArgs(),
				);
			if (tools?.some((t) => t.function.name === UNAVAILABLE))
				return unavailableReceipt("request-1", "了解です");
			return {
				requestId: "request-1",
				attemptId: "attempt",
				value: "了解です",
			};
		},
		acceptInTransaction: () => true,
		answer: async () => "了解です",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as InferencePort;
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const realMemory = scenario.memory
		? createMemoryService(store, conversation, continuity, {
				journalPath: join(dir, "journal.jsonl"),
			})
		: undefined;
	await realMemory?.recover();

	// Earlier completed turns, through the real queue and the same fake model.
	const seedQueue = createQueue(store);
	const seed = createDialogueService({
		store,
		conversation,
		larm,
		queue: seedQueue,
		memory: realMemory,
	});
	seedQueue.start();
	for (const text of TURN_TEXTS.slice(0, scenario.turns ?? 3)) {
		const turn = await seed.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		await until(() => seed.get(turn.id)?.status === "completed");
	}
	await seedQueue.close(100);

	let memory: MemoryService | undefined = realMemory;
	if (realMemory && scenario.memory !== "empty") {
		const exchanges = realMemory.exchanges("main");
		const first = exchanges[0];
		if (first)
			await store.write((db) =>
				db
					.query(
						"UPDATE memory_exchange SET disposition = 'keep' WHERE input_message_id = ?",
					)
					.run(first.inputMessageId),
			);
		const keepRef = first
			? {
					inputMessageId: first.inputMessageId,
					answerMessageId: first.answerMessageId,
				}
			: undefined;
		const pin = exchanges.at(-1)?.inputMessageId;
		memory = {
			...realMemory,
			windowForRunInTransaction: (db, conversationId) => {
				const real = realMemory.windowForRunInTransaction(db, conversationId);
				return real
					? craftedWindow(real, scenario.memory!, keepRef, pin)
					: null;
			},
			recallTurnsInRead: () =>
				scenario.recall
					? {
							text: scenario.recall,
							pins: [],
						}
					: null,
		} as MemoryService;
	}

	const ticket: AnswerTicket | undefined = scenario.agent
		? {
				taskId: "t",
				eventId: "event-1",
				revision: 1,
				dataEpoch: 0,
				reportTaskId: "c",
				reportEpoch: 3,
				reportDigest: null,
				projection: null,
				failureCode: null,
				...scenario.agent,
			}
		: undefined;
	const agents = ticket
		? ({
				startInTransaction: () => ({ taskId: "t", jobId: "unused" }),
				prepareAnswerInTransaction: () => ticket,
				completeAnswerInTransaction: () => {},
				validAnswerInTransaction: () => true,
				failAnswerInTransaction: () => {},
				pendingEvents: () => [],
				byRootInTransaction: () => null,
			} as unknown as AgentRuntime)
		: undefined;

	const queue = createQueue(store);
	let handler:
		| HandlerDefinition<GeneratePayload, GenerateInput, unknown>
		| undefined;
	const register = queue.registerHandler.bind(queue);
	(queue as QueueService).registerHandler = ((h: any) => {
		if (h.kind === GENERATE_KIND) handler = h;
		return register(h);
	}) as QueueService["registerHandler"];
	const toolchains = scenario.cards
		? ({
				embedQuery: async () =>
					scenario.recall ? { space: "s", vector: [1] } : undefined,
				routeInTransaction: () => ({
					cards: [
						{
							revisionId: "toolchain:fake@1",
							id: "fake.studio",
							functionName: "studio_create",
							title: "fake.studio",
							summary: "共同で作る",
							useWhen: ["作る"],
							redirects: [],
							score: {
								rank: 1,
								ftsRank: null,
								similarity: null,
								fromHistory: false,
							},
						},
					],
					past: [
						{
							selectionId: "sel-1",
							request: "前の依頼",
							functionName: "studio_create",
							outcome: "answered",
						},
					],
					retrieval: "none",
				}),
				catalogInTransaction: () => [],
				resolveInTransaction: () => {
					throw new Error("unexpected");
				},
				commandSetInTransaction: () => {
					throw new Error("unexpected");
				},
				recordSelectionInTransaction: () => "selection",
				linkTaskInTransaction: () => {},
				settleSelectionInTransaction: () => {},
				requestOfRunInTransaction: () => undefined,
			} as never)
		: scenario.recall
			? ({
					embedQuery: async () => ({ space: "s", vector: [1] }),
					routeInTransaction: () => ({
						cards: [],
						past: [],
						retrieval: "none",
					}),
					catalogInTransaction: () => [],
				} as never)
			: ({
					embedQuery: async () => undefined,
					routeInTransaction: () => ({
						cards: [],
						past: [],
						retrieval: "none",
					}),
					catalogInTransaction: () => [],
				} as never);
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
		agents,
		toolchains,
		clock: () => FIXED_CLOCK,
		goals: scenario.goals
			? {
					adoptedForContextInTransaction: () => [
						{
							goalId: "g1",
							priority: 1,
							desiredState: "毎日少し運動する",
							revision: 1,
						},
					],
					existingInTransaction: () => new Set(["g1"]),
				}
			: undefined,
		worldContext: scenario.worldNames
			? { knownNamesInTransaction: () => scenario.worldNames! }
			: undefined,
		excalidraw: scenario.excalidraw
			? ({ resultInTransaction: () => scenario.excalidraw } as never)
			: undefined,
		objectRecognition: scenario.recognition
			? ({ resultInTransaction: () => scenario.recognition } as never)
			: undefined,
		image: scenario.image
			? ({ resultInTransaction: () => scenario.image } as never)
			: undefined,
		music: scenario.music
			? ({ resultInTransaction: () => scenario.music } as never)
			: undefined,
		delegation: scenario.delegation
			? ({
					prepareInTransaction: () => ({
						catalog: {},
						receipt: scenario.delegation,
						available: true,
					}),
				} as never)
			: undefined,
	});
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: scenario.text ?? "今日のニュースは？",
	});
	if (ticket)
		await store.write((db) =>
			db
				.query("UPDATE dialogue_runs SET agent_task_id='t' WHERE id=?")
				.run(run.id),
		);
	const claim = {
		jobId: `job-${run.id}`,
		scope: "dialogue",
		kind: GENERATE_KIND,
		payloadVersion: 1,
		payload: {
			runId: run.id,
			...(scenario.commandNote ? { commandNote: scenario.commandNote } : {}),
			...(scenario.specialistHandoff
				? { specialistHandoff: scenario.specialistHandoff }
				: {}),
		},
		subjectRef: null,
		owner: "o",
		attempt: 1,
		generation: 1,
		maxAttempts: 1,
		deadlineAtMs: Date.parse(FIXED_CLOCK) + 60_000,
	};
	const prepared = await store.write((tx) => {
		// The run is queued: the real job is not started (the queue is not running), so the claim is made here.
		claim.jobId =
			(dialogue.get(run.id) as { jobId: string | null }).jobId ?? claim.jobId;
		return handler!.prepareInTransaction(tx, claim as never);
	});
	if (prepared.status !== "ready")
		throw new Error(`prepare_${prepared.reason}`);
	const input = prepared.input;
	recording = true;
	await handler!.execute(input, {
		signal: new AbortController().signal,
		jobId: claim.jobId,
		attempt: 1,
		generation: 1,
	});
	await dialogue.close();
	const assembly = await store.write((tx) => {
		const stored = byId(tx, run.id)!;
		return compileAssembly(
			tx,
			stored,
			conversation,
			undefined,
			memory?.windowForRunInTransaction(tx, "main") ?? null,
			memory,
			null,
			false,
		).assembly;
	});
	const ledgerMessageIds = (realMemory?.exchanges("main") ?? []).flatMap(
		(exchange) => [
			exchange.inputMessageId,
			...(exchange.answerMessageId ? [exchange.answerMessageId] : []),
		],
	);
	return {
		assembly,
		ledgerMessageIds,
		prepared: {
			messages: normalizeMessages(input.messages),
			sessionContext: input.sessionContext ?? null,
			currentRequest: {
				messageId: normalize(input.currentRequest.messageId),
				messageIndex: input.currentRequest.messageIndex,
			},
			actionResultIndex: input.actionResultIndex ?? null,
			flags: {
				operationResult: !!input.operationResult,
				mediaResult: !!input.mediaResult,
				routing: !!input.routing,
				agent: !!input.agent,
				memory: !!input.memory,
				goals: !!input.goals,
			},
		},
		calls,
	};
}

const report = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		version: 2,
		outcome: "answered",
		summary: "報告の要約",
		claims: [{ text: "確認済み", sourceIds: ["s1"] }],
		sources: [{ sourceId: "s1", url: "https://example.com/" }],
		...extra,
	});
const worldReport = report({
	sources: [
		{ sourceId: "w1", kind: "world_claim", origin: "model_hypothesis" },
		{ sourceId: "w2", kind: "world_document" },
	],
	claims: [{ text: "経費精算に依存", sourceIds: ["w1", "w2"] }],
});
const LAYERS: Scenario = {
	memory: "layers",
	goals: true,
	worldNames: ["音声サービス"],
};

export const SCENARIOS: Record<string, Scenario> = {
	"no-memory": {},
	"memory-empty": { memory: "empty" },
	"all-layers": LAYERS,
	"all-layers-selection": {
		...LAYERS,
		cards: true,
		recall: "過去のやり取りの想起",
	},
	"prefetch-dropped": { memory: "layers-prefetch-dropped", goals: true },
	"world-hint": { worldNames: ["音声サービス", "請求システム"] },
	"research-success": {
		...LAYERS,
		agent: { projection: report() },
	},
	"research-success-world": {
		...LAYERS,
		agent: { projection: worldReport },
	},
	"result-action": {
		...LAYERS,
		agent: {
			actionPayload: JSON.stringify({
				action: "list",
				items: [{ id: "1" }],
				complete: true,
			}),
		},
	},
	"result-recognition": {
		...LAYERS,
		recognition: {
			status: "completed",
			objects: [{ label: "cup", score: 0.9 }],
		},
	},
	"result-delegation": {
		memory: "layers",
		delegation: { state: "accepted", taskId: "d1" },
	},
	"result-drawing": {
		memory: "layers",
		excalidraw: { status: "completed", url: "/draw/1" },
	},
	"result-image": {
		...LAYERS,
		image: { status: "completed", action: "generate" },
	},
	"result-music": {
		memory: "layers",
		music: { status: "completed", kind: "playlist", trackIds: ["t1"] },
	},
	"command-question": {
		memory: "layers",
		commandNote: "どの画像サイズにしますか",
	},
	"results-together": {
		...LAYERS,
		recognition: { status: "completed" },
		delegation: { state: "accepted" },
		excalidraw: { status: "completed" },
		image: { status: "completed" },
		music: { status: "completed" },
		commandNote: "確認です",
	},
	"handoff-without-specialist-port": {
		memory: "layers",
		specialistHandoff: "work=suspended",
	},
};
