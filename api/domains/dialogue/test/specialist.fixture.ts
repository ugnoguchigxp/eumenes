import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ToolchainCard } from "../../capabilities";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../conversation";
import {
	createContinuityService,
	itemSourceMigration,
	migration as continuityMigration,
	shortTermMigration,
} from "../../continuity";
import type { InferencePort, Receipt } from "../../inference";
import {
	agentHardeningMigration,
	contextWindowMigration,
	createMemoryService,
	forgetClosureMigration,
	migration as memoryMigration,
	seedImportMigration,
	specialistBlockReasonMigration,
	stewardLedgersMigration,
	turnVectorsMigration,
} from "../../memory";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
	announcementMigration,
	specialistMigration,
	type SpecialistPort,
	type SpecialistSet,
	type ToolchainRoutingPort,
} from "..";
import {
	analysisReceipt,
	ANSWER,
	isAnalysisRound,
	NOTICE,
	offeredToolchains,
	UNAVAILABLE,
} from "./analysis.fixture";
import type { RequestAnalysis } from "../service/initial-decision";

export const REVISION = "toolchain:fake.studio@1";
export const OTHER_REVISION = "toolchain:fake.other@1";
export const ADAPTER = "adapter:fake-studio@1";
export const OTHER_ADAPTER = "adapter:fake-other@1";

const MIGRATIONS = [
	...conversationMigrations,
	dialogueMigration,
	queueMigration,
	queueLinkMigration,
	announcementMigration,
	specialistMigration,
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
	specialistBlockReasonMigration,
	...memoryPackageMigrations,
];

const card = (
	revisionId: string,
	id: string,
	functionName: string,
): ToolchainCard => ({
	revisionId,
	id,
	functionName,
	title: id,
	summary: "共同で作る",
	useWhen: ["作る"],
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
});

export const setFor = (revisionId: string): SpecialistSet => {
	const other = revisionId === OTHER_REVISION;
	return {
		toolchainId: other ? "fake.other" : "fake.studio",
		toolchainRevisionId: revisionId,
		title: other ? "別の担当" : "制作担当",
		bindingRevisionId: other ? "binding:fake.other@1" : "binding:fake.studio@1",
		adapterRef: other ? OTHER_ADAPTER : ADAPTER,
		artifactRevisionId: other
			? "artifact:fake.other@1"
			: "artifact:fake.studio@1",
		packageRevisionId: other ? "package:fake.other@1" : "package:fake.studio@1",
		profile: "制作の専門担当",
		skills: ["手順"],
		tools: [
			{
				id: "draft.apply",
				toolRevisionId: "tool:draft.apply@1",
				operationName: "fake.draft.apply",
				inputSchemaRef: "builtin:fakeDraft",
				summary: "下書きへ反映する",
				schema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
					additionalProperties: false,
				},
			},
		],
		targetSchemaRef: other ? null : "builtin:fakeTarget",
	};
};

type Work = {
	workRef: string;
	adapterRef: string;
	savedRef: string | null;
	dirty: boolean;
	holder: string | null;
	revision: number;
	label: string;
	current: unknown;
	ended: boolean;
};

export type Call = {
	preparation?: import("../../delivery").SpeechPreparation;
	history: Array<{ role: string; content: string }>;
	tools: Array<{
		function: {
			name: string;
			description?: string;
			parameters: Record<string, unknown>;
		};
	}>;
};

export type Options = { memory?: boolean };

/** A real store, queue, memory and dialogue with fake models and a fake session toolchain. */
export async function setup(options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-specialist-"));
	const store: SqliteStore = openStore(join(dir, "db.sqlite3"), MIGRATIONS);
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory =
		options.memory === false
			? undefined
			: createMemoryService(store, conversation, continuity, {
					journalPath: join(dir, "journal.jsonl"),
				});
	await memory?.recover();
	const state = {
		offsetMs: 0,
		receiptAllowed: true,
		/** While set, a specialist model call waits for it (a turn in flight). */
		gate: null as Promise<void> | null,
		/** The main conversation model's replies in order; undefined falls back to prose. */
		main: [] as Array<
			| { toolCalls: Array<{ id: string; name: string; arguments: string }> }
			| string
		>,
		/** The specialist's replies in order (objects are JSON-encoded). */
		specialist: [] as Array<unknown>,
		mainCalls: [] as Call[],
		/** The first round's calls (the request analysis), apart from the main calls that follow. */
		analysisCalls: [] as Call[],
		/**
		 * The first round's replies in order: the function it calls (`call`: a toolchain's, "answer" or
		 * "report_unavailable") with the analysis. Without one, a scripted function call delegates to that function
		 * (its `announcement` is the notice), a prose reply with no candidates is reported as unavailable, and
		 * any other prose answers.
		 */
		analyses: [] as Array<
			Partial<RequestAnalysis> & {
				call?: string;
				announcement?: string;
				reply?: string;
			}
		>,
		noCandidates: false,
		routeCalls: 0,
		/** The text each candidate search ran on. */
		routeTexts: [] as string[],
		/** What the conversation recorded as its decisions. */
		recorded: [] as Array<Record<string, unknown>>,
		specialistPrompts: [] as Array<Array<{ role: string; content: string }>>,
		specialistSessions: [] as unknown[],
		captures: [] as Array<Record<string, unknown>>,
		works: new Map<string, Work>(),
		invocations: [] as Array<Record<string, unknown>>,
		endWorkFails: false,
		/** A safe code the next operations are refused with. */
		invokeError: null as string | null,
		/** A repair hint the refusal carries (as the ui adapter's errors do). */
		invokeDetail: null as string | null,
		calls: [] as string[],
		released: [] as string[],
		settled: [] as Array<{ outcome: string; code?: string | null }>,
	};
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		captureInTransaction: () => {},
		requestFor: () => "request",
		setContextPolicyInTransaction: () => {},
		validateReceiptInTransaction: () => state.receiptAllowed,
		acceptInTransaction: () => state.receiptAllowed,
		releaseTaskSession: async (taskId: string) => {
			state.released.push(taskId);
		},
		snapshotInTransaction: () => ({ subagent: { resourceId: null } }),
		captureControlInTransaction: (
			_db: unknown,
			input: Record<string, unknown>,
		) => {
			state.captures.push(input);
			return "control";
		},
		executeControl: async (
			requestId: string,
			prompt: Array<{ role: string; content: string }>,
			_signal?: AbortSignal,
			control?: { instructions?: string },
			session?: unknown,
		) => {
			if (
				prompt[0]?.content.includes("OUTPUT_SCHEMA=") &&
				!control?.instructions
			)
				return {
					requestId,
					attemptId: "route",
					value: JSON.stringify({
						decision: "answer",
						functionName: "",
						request: "",
						questionRef: "",
					}),
				} as Receipt;
			state.specialistPrompts.push([...prompt]);
			state.specialistSessions.push(session);
			// A call waiting on the gate still honours cancellation, as a provider call does.
			await Promise.race([
				state.gate,
				new Promise<void>((_, reject) => {
					if (_signal?.aborted) reject(new Error("aborted"));
					_signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
			]);
			const next = state.specialist.shift();
			if (next === undefined) throw new Error("fixture_specialist_missing");
			return {
				requestId,
				attemptId: `s${state.specialistPrompts.length}`,
				value: typeof next === "string" ? next : JSON.stringify(next),
			} as Receipt;
		},
		executeRequest: async () => {
			throw new Error("unexpected_request");
		},
		executeStream: async (
			requestId: string,
			history: Call["history"],
			_signal: AbortSignal,
			delta: (text: string) => void,
			preparation: Call["preparation"],
			tools: Call["tools"] | undefined,
		) => {
			const call = { history: [...history], tools: tools ?? [], preparation };
			if (isAnalysisRound(tools)) {
				state.analysisCalls.push(call);
				const { call: named, announcement, reply, ...over } =
					state.analyses.shift() ?? {};
				const head = state.main[0];
				const offered = offeredToolchains(tools);
				const scripted =
					typeof head === "string" || head === undefined
						? undefined
						: head.toolCalls[0];
				const chosen =
					named ??
					(scripted && offered.includes(scripted.name)
						? scripted.name
						: scripted
							? offered[0]
							: undefined);
				if (chosen && chosen !== ANSWER && chosen !== UNAVAILABLE)
					return analysisReceipt(requestId, {
						name: chosen,
						args: over,
						announcement:
							announcement ??
							(scripted
								? JSON.parse(scripted.arguments).announcement
								: undefined) ??
							NOTICE,
					});
				if (
					chosen === UNAVAILABLE ||
					(!chosen && !offered.length && typeof head === "string" && !named)
				)
					return analysisReceipt(requestId, {
						name: UNAVAILABLE,
						args: over,
						reply: reply ?? (state.main.shift() as string),
					});
				return analysisReceipt(requestId, { name: ANSWER, args: over });
			}
			state.mainCalls.push(call);
			const reply = state.main.shift() ?? "了解しました";
			if (typeof reply !== "string")
				// The notice belongs to the first round: the second round's function takes the request only.
				return {
					requestId,
					attemptId: "main",
					value: "",
					toolCalls: reply.toolCalls.map((c) => {
						const { announcement: _notice, ...rest } = JSON.parse(c.arguments);
						return { ...c, arguments: JSON.stringify(rest) };
					}),
				} as unknown as Receipt;
			delta(reply);
			return { requestId, attemptId: "main", value: reply } as Receipt;
		},
		answer: async () => "了解しました",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	} as unknown as InferencePort;

	const fail = (code: string): never => {
		throw new Error(code);
	};
	const workOf = (adapterRef: string, workRef: string) => {
		const work = state.works.get(workRef);
		return work && work.adapterRef === adapterRef ? work : undefined;
	};
	const view = (work: Work) => ({
		workRef: work.workRef,
		savedRef: work.savedRef,
		dirty: work.dirty,
		busy: work.holder !== null,
		revision: work.revision,
		label: work.label,
		current: work.current,
	});
	const specialist: SpecialistPort = {
		setInTransaction: (_db, revision) => {
			if (![REVISION, OTHER_REVISION].includes(revision))
				fail("capability_unavailable");
			return setFor(revision);
		},
		// "item-old" is a real saved item beyond the recent choices: only an `include` offers it.
		targetChoicesInTransaction: (_db, set, include) =>
			set.targetSchemaRef
				? [
						...(include === "item-old"
							? [{ ref: "item-old", label: "古い項目" }]
							: []),
						{ ref: "item-1", label: "保存済み1" },
						{ ref: "item-2", label: "保存済み2" },
					]
				: [],
		openWorkInTransaction: (_db, set, input) => {
			if (
				input.targetRef &&
				!["item-1", "item-2", "item-old"].includes(input.targetRef)
			)
				fail("target_not_found");
			const work: Work = {
				workRef: `work-${input.sessionId}`,
				adapterRef: set.adapterRef,
				savedRef: input.targetRef,
				dirty: false,
				holder: null,
				revision: 1,
				label: input.targetRef ? `保存済み ${input.targetRef}` : "新規",
				current: { title: "" },
				ended: false,
			};
			state.works.set(work.workRef, work);
			state.calls.push("open");
			return view(work);
		},
		workStateInTransaction: (_db, adapterRef, workRef) => {
			const work = workOf(adapterRef, workRef);
			return work && !work.ended ? view(work) : null;
		},
		beginTurnInTransaction: (_db, adapterRef, workRef, runId) => {
			const work = workOf(adapterRef, workRef);
			if (!work || work.ended) return fail("work_not_found");
			if (work.holder) return fail("work_busy");
			work.holder = runId;
		},
		endTurnInTransaction: (_db, adapterRef, workRef, runId) => {
			const work = workOf(adapterRef, workRef);
			if (work?.holder === runId) work.holder = null;
		},
		endWorkInTransaction: (_db, adapterRef, workRef, mode) => {
			const work = workOf(adapterRef, workRef);
			if (!work || work.ended) return;
			if (state.endWorkFails) return fail("domain_down");
			if (work.holder) return fail("work_busy");
			if (mode === "close" && work.dirty) return fail("work_unsaved");
			work.ended = true;
			state.calls.push(`end:${mode}`);
		},
		parseInvocation: (set, toolId, args) => {
			const tool = set.tools.find((t) => t.id === toolId);
			if (!tool) return { ok: false, code: "specialist_tool_unknown" };
			const title = (args as { title?: unknown })?.title;
			return typeof title === "string"
				? {
						ok: true,
						operationName: tool.operationName,
						input: { title },
					}
				: {
						ok: false,
						code: "specialist_invalid_arguments",
						detail: ["title: invalid_type expected=string"],
					};
		},
		invokeInTransaction: (_db, set, input) => {
			if (state.invokeError)
				throw Object.assign(
					new Error(state.invokeError),
					state.invokeDetail ? { detail: state.invokeDetail } : {},
				);
			const work = workOf(set.adapterRef, input.workRef);
			if (!work || work.holder !== input.runId) return fail("work_busy");
			work.dirty = true;
			work.revision += 1;
			work.current = { title: input.input.title };
			work.label = String(input.input.title);
			state.invocations.push(input as unknown as Record<string, unknown>);
			return { answerContext: { applied: true, revision: work.revision } };
		},
		afterCommit: () => {},
	};
	const routed: ToolchainCard[] = [
		card(REVISION, "fake.studio", "studio_create"),
		card(OTHER_REVISION, "fake.other", "other_create"),
	];
	const toolchains: ToolchainRoutingPort = {
		embedQuery: async () => undefined,
		routeInTransaction: (_db, input) => {
			state.routeCalls++;
			state.routeTexts.push(input.text);
			return {
				cards: state.noCandidates ? [] : routed,
				past: [],
				retrieval: "none",
			};
		},
		catalogInTransaction: () =>
			[REVISION, OTHER_REVISION].map((revisionId) => {
				const set = setFor(revisionId);
				return {
					id: set.toolchainId,
					revisionId,
					runtime: {
						execution: "session" as const,
						binding: {
							bindingRevisionId: set.bindingRevisionId,
							adapterRef: set.adapterRef,
							artifactRevisionId: set.artifactRevisionId,
							available: true,
						},
					},
				};
			}),
		resolveInTransaction: (_db, revisionId) => {
			const set = setFor(revisionId);
			return {
				toolchain: { functionName: "x" } as never,
				packageRevisionId: set.packageRevisionId,
				runtime: {
					execution: "session" as const,
					binding: {
						bindingRevisionId: set.bindingRevisionId,
						adapterRef: set.adapterRef,
						artifactRevisionId: set.artifactRevisionId,
						available: true,
					},
				},
			};
		},
		sessionSetInTransaction: (_db, revisionId) =>
			specialist.setInTransaction(_db, revisionId),
		commandSetInTransaction: () => {
			throw new Error("unexpected_command");
		},
		recordSelectionInTransaction: (_db, input) => {
			state.recorded.push(input as unknown as Record<string, unknown>);
			return "selection";
		},
		linkTaskInTransaction: () => {},
		settleSelectionInTransaction: (_db, _runId, result) => {
			state.settled.push(result);
		},
		requestOfRunInTransaction: () => undefined,
	};
	const queue = createQueue(store);
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue,
		memory,
		toolchains,
		specialist,
		clock: () => new Date(Date.now() + state.offsetMs).toISOString(),
	});
	queue.start();
	const closers = async () => {
		await dialogue.close();
		await queue.close(100).catch(() => {});
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	};
	const terminal = ["completed", "failed", "cancelled", "interrupted"];
	const h = {
		store,
		conversation,
		memory,
		dialogue,
		state,
		close: closers,
		/** Accept a user message (no waiting). */
		say: (text: string, extra: Record<string, unknown> = {}) =>
			dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
				...extra,
			}),
		/** Accept a message and wait until its run ended. */
		async ask(text: string, extra: Record<string, unknown> = {}) {
			const run = await h.say(text, extra);
			await h.finished(run.id);
			return dialogue.get(run.id)!;
		},
		finished: (runId: string) =>
			waitFor(() => terminal.includes(dialogue.get(runId)?.status ?? ""), {
				timeout: 4000,
			}),
		until: (check: () => boolean) => waitFor(check, { timeout: 4000 }),
		/** The main model hands the next utterance to the session toolchain. */
		startCall(args: Record<string, unknown>, name = "studio_create") {
			state.main.push({
				toolCalls: [
					{
						id: "call",
						name,
						arguments: JSON.stringify({
							announcement: "担当に引き継ぎます。",
							...args,
						}),
					},
				],
			});
		},
		session: () => dialogue.specialistSession("main"),
		rows: (sql: string, ...params: Array<string | number>) =>
			store.read((db) => db.query(sql).all(...params) as any[]),
		blocked: () =>
			memory?.blockedMessageIdsOfConversationInTransaction
				? store.read((db) =>
						memory.blockedMessageIdsOfConversationInTransaction(db, "main"),
					)
				: [],
		work: () => [...state.works.values()],
	};
	return h;
}
export type Harness = Awaited<ReturnType<typeof setup>>;
