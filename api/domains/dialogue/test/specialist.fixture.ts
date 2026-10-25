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
	RejectedDraft,
	SpecialistPort,
	SpecialistSet,
	StewardPort,
} from "../contracts";
import type { ImagePort } from "../contracts/image";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import type { ChatMessage } from "../service/context";
import {
	IMAGE,
	sectionLines,
	type Call,
	type Step,
} from "./generation.fixture";
import { openDialogueStore } from "./store.fixture";
import { testConversationAgent } from "./conversation-agent.fixture";

export { IMAGE, type Call, type Step };

export const REVISION = "toolchain:fake.studio@1";
export const OTHER_REVISION = "toolchain:fake.other@1";
export const ADAPTER = "adapter:fake-studio@1";
export const OTHER_ADAPTER = "adapter:fake-other@1";
export const STUDIO_ARTIFACT = "artifact:fake.studio@1";

/** The session toolchains the scripted conversation can hand over to. */
const sessionCard = (
	revisionId: string,
	id: string,
	title: string,
): ToolchainCard => ({
	revisionId,
	id,
	functionName: id.replace(".", "_"),
	title,
	summary: "共同で作る",
	useWhen: ["作る"],
	execution: "session",
	redirects: [],
	score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
});
export const STUDIO = sessionCard(REVISION, "fake.studio", "制作担当");
export const OTHER = sessionCard(OTHER_REVISION, "fake.other", "別の担当");

export const NO_AGENT: SpecialistSet["agent"] = {
	document: null,
	sharedTools: [],
};
export const DOCUMENT_AGENT: SpecialistSet["agent"] = {
	document: {
		ref: "workspace:fake.document@1",
		path: "page.json",
		mediaType: "application/json",
	},
	sharedTools: [],
};

export type Options = {
	/** Real memory service (its journal in the test directory); default true. */
	memory?: boolean;
	/** The studio's time limits; the other toolchain keeps the host defaults. */
	limits?: SpecialistSet["timeLimits"];
	/** The studio's agent settings: a work document makes the host offer doc.* tools. */
	agent?: SpecialistSet["agent"];
};

/** The fixture document's canonical text: the same value always gives the same text. */
const canonical = (value: unknown) => JSON.stringify(value, null, 2);

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
	/** The work document's canonical text and the whole draft kept after a failed check. */
	text: string;
	rejected: RejectedDraft | null;
};

/** A specialist model call as the fake saw it. */
export type SpecialistCall = Array<{ role: string; content: string }>;

/** A real store, queue, memory and dialogue with a scripted conversation model, a fake specialist and session toolchains. */
export async function setup(options: Options = {}) {
	const { dir, store } = openDialogueStore("eumenes-specialist-");
	const conversation = createConversationService(store);
	const continuity = createContinuityService(store);
	const memory: MemoryService | undefined =
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
		/** The conversation model's replies, in order (one per model call). */
		steps: [] as Step[],
		/** Every call the conversation model received. */
		calls: [] as Call[],
		/** The specialist's replies in order (objects are JSON-encoded). */
		specialist: [] as unknown[],
		specialistPrompts: [] as SpecialistCall[],
		specialistSessions: [] as unknown[],
		captures: [] as Array<Record<string, unknown>>,
		/** Model-request deadlines the run moved later (subject and new deadline). */
		extended: [] as Array<{ subject: string; deadline: number }>,
		works: new Map<string, Work>(),
		invocations: [] as Array<Record<string, unknown>>,
		endWorkFails: false,
		/** A safe code the next operations are refused with. */
		invokeError: null as string | null,
		/** A refusal the fake work document's commit throws (as a domain does, a plain Error(code)). */
		commitError: null as string | null,
		/** A repair hint the refusal carries (as the ui adapter's errors do). */
		invokeDetail: null as string | null,
		calledPort: [] as string[],
		released: [] as string[],
		runEnds: [] as Array<Parameters<StewardPort["runEndedInTransaction"]>[1]>,
		images: new Map<string, unknown>(),
	};
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
	const aborted = (signal?: AbortSignal) =>
		new Promise<void>((_, reject) => {
			if (signal?.aborted) reject(new Error("aborted"));
			signal?.addEventListener("abort", () => reject(new Error("aborted")));
		});
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		captureInTransaction: () => {},
		captureControlInTransaction: (
			_db: unknown,
			input: Record<string, unknown>,
		) => {
			state.captures.push(input);
			return "control";
		},
		requestFor: (_db: unknown, runId: string) => `req:${runId}`,
		llmContextWindowInTransaction: () => undefined,
		setContextPolicyInTransaction: () => {},
		validateReceiptInTransaction: () => state.receiptAllowed,
		acceptInTransaction: () => state.receiptAllowed,
		releaseTaskSession: async (taskId: string) => {
			state.released.push(taskId);
		},
		extendDeadlineInTransaction: (
			_db: unknown,
			subject: string,
			deadline: number,
		) => {
			state.extended.push({ subject, deadline });
		},
		answer: async () => {
			throw new Error("unexpected_answer");
		},
		/** The specialist's call: its next scripted reply. */
		executeControl: async (
			requestId: string,
			prompt: SpecialistCall,
			signal?: AbortSignal,
			_control?: unknown,
			session?: unknown,
		) => {
			state.specialistPrompts.push([...prompt]);
			state.specialistSessions.push(session);
			// A call waiting on the gate still honours cancellation, as a provider call does.
			await Promise.race([state.gate, aborted(signal)]);
			const next = state.specialist.shift();
			if (next === undefined) throw new Error("fixture_specialist_missing");
			return {
				requestId,
				attemptId: `s${state.specialistPrompts.length}`,
				value: typeof next === "string" ? next : JSON.stringify(next),
			} as Receipt;
		},
		/** The conversation's call: its next scripted step. */
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
			const step = state.steps.shift();
			if (!step) throw new Error("fixture_step_missing");
			signal.throwIfAborted();
			if (step.text) delta(step.text);
			return receipt(requestId, step);
		},
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
	const setFor = (revisionId: string): SpecialistSet => {
		const other = revisionId === OTHER_REVISION;
		return {
			toolchainId: other ? "fake.other" : "fake.studio",
			toolchainRevisionId: revisionId,
			title: other ? "別の担当" : "制作担当",
			bindingRevisionId: other
				? "binding:fake.other@1"
				: "binding:fake.studio@1",
			adapterRef: other ? OTHER_ADAPTER : ADAPTER,
			artifactRevisionId: other ? "artifact:fake.other@1" : STUDIO_ARTIFACT,
			packageRevisionId: other
				? "package:fake.other@1"
				: "package:fake.studio@1",
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
			timeLimits: other ? null : (options.limits ?? null),
			agent: other ? NO_AGENT : (options.agent ?? NO_AGENT),
		};
	};
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
				text: canonical({ view: "page", items: [] }),
				rejected: null,
			};
			state.works.set(work.workRef, work);
			state.calledPort.push("open");
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
			state.calledPort.push(`end:${mode}`);
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
		documentOf: (adapterRef) =>
			adapterRef !== ADAPTER
				? null
				: {
						readInTransaction: (_db, workRef) => {
							const work = workOf(adapterRef, workRef);
							return work && !work.ended
								? {
										revision: work.revision,
										title: work.label,
										text: work.text,
										rejected: work.rejected,
									}
								: null;
						},
						// A page is an object whose "view" is "page"; a "dropMe" key is what the fixer drops.
						check: (text) => {
							let value: Record<string, unknown>;
							try {
								value = JSON.parse(text);
							} catch {
								return {
									ok: false,
									code: "document_parse_failed",
									issues: [{ path: "(root)", rule: "json" }],
									fixes: [],
								};
							}
							const fixes: string[] = [];
							if ("dropMe" in value) {
								delete value.dropMe;
								fixes.push("drop_part:dropMe");
							}
							return value.view === "page"
								? { ok: true, value, fixes }
								: {
										ok: false,
										code: "document_invalid",
										issues: [{ path: "view", rule: "page_only" }],
										fixes,
									};
						},
						commitInTransaction: (_db, workRef, input) => {
							const work = workOf(adapterRef, workRef);
							if (!work || work.holder !== input.runId)
								return fail("turn_not_current");
							if (input.baseRevision !== work.revision)
								return fail("revision_conflict");
							if (state.commitError) return fail(state.commitError);
							const text = canonical(input.value);
							const title = input.title ?? work.label;
							if (text === work.text && title === work.label)
								return fail("no_change");
							work.text = text;
							work.label = title;
							work.revision += 1;
							work.dirty = true;
							work.rejected = null;
							state.invocations.push({ document: text });
							return { revision: work.revision };
						},
						rejectInTransaction: (_db, workRef, draft) => {
							const work = workOf(adapterRef, workRef);
							if (work)
								work.rejected = {
									...draft,
									createdAt: "2026-10-18T00:00:00.000Z",
								};
						},
					},
	};

	const cards: ToolchainCard[] = [STUDIO, OTHER, IMAGE];
	const cardOf = (revisionId: string) =>
		cards.find((c) => c.revisionId === revisionId);
	const sessionRuntime = (revisionId: string): ToolchainRuntimeMeta => {
		const set = setFor(revisionId);
		return {
			execution: "session",
			binding: {
				bindingRevisionId: set.bindingRevisionId,
				adapterRef: set.adapterRef,
				artifactRevisionId: set.artifactRevisionId,
				available: true,
			},
		} as ToolchainRuntimeMeta;
	};
	const runtimeOf = (revisionId: string): ToolchainRuntimeMeta =>
		[REVISION, OTHER_REVISION].includes(revisionId)
			? sessionRuntime(revisionId)
			: ({ execution: "image", requires: "image" } as ToolchainRuntimeMeta);
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
		cardInTransaction: (_db: unknown, revisionId: string) => cardOf(revisionId),
		catalogInTransaction: () =>
			cards.map((c) => ({
				id: c.id,
				revisionId: c.revisionId,
				runtime: runtimeOf(c.revisionId),
			})),
		resolveInTransaction: (_db: unknown, revisionId: string) => {
			if (!cardOf(revisionId)) throw new Error("toolchain_unavailable");
			return {
				toolchain: {},
				packageRevisionId: [REVISION, OTHER_REVISION].includes(revisionId)
					? setFor(revisionId).packageRevisionId
					: "package:fake.image@1",
				runtime: runtimeOf(revisionId),
			};
		},
		sessionSetInTransaction: (_db: unknown, revisionId: string) =>
			specialist.setInTransaction(_db as never, revisionId),
		recordSelectionInTransaction: () => "selection",
		settleSelectionInTransaction: () => {},
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
	const steward: StewardPort = {
		runEndedInTransaction: (_db, input) => {
			state.runEnds.push(input);
		},
		requestInTransaction: () => ({ id: "request", replay: false }),
	};
	const queue = createQueue(store);
	const dialogue = createDialogueService({
		conversationAgent: testConversationAgent,
		store,
		conversation,
		larm,
		queue,
		continuity,
		memory,
		toolchains,
		specialist,
		image,
		steward,
		clock: () => new Date(Date.now() + state.offsetMs).toISOString(),
	});
	queue.start();
	const terminal = ["completed", "failed", "cancelled", "interrupted"];
	const h = {
		store,
		conversation,
		continuity,
		memory,
		dialogue,
		state,
		async close() {
			await dialogue.close();
			await queue.close(100).catch(() => {});
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
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
		/**
		 * Script the conversation model to hand the next utterance to a session toolchain: it searches, then
		 * delegates (execute) with the announcement that precedes the hand-over.
		 */
		handOver(
			args: { request: string } & Record<string, unknown>,
			toolchain: string = STUDIO.id,
		) {
			state.steps.push(
				{ calls: [{ name: "find_toolchain", args: { query: args.request } }] },
				{
					calls: [
						{
							name: "delegate",
							args: {
								mode: "execute",
								toolchain,
								impact: "create",
								announcement: "担当に引き継ぎます。",
								...args,
							},
						},
					],
				},
			);
		},
		session: () => dialogue.specialistSession("main"),
		rows: (sql: string, ...params: Array<string | number>) =>
			store.read((db) => db.query(sql).all(...params) as any[]),
		blocked: () =>
			memory
				? store.read((db) =>
						memory.blockedMessageIdsOfConversationInTransaction(db, "main"),
					)
				: [],
		work: () => [...state.works.values()],
		log(): ConversationEvent[] {
			return store.read((db) => continuity.events.logInTransaction(db, "main"));
		},
		fields(event: ConversationEvent) {
			return JSON.parse(event.text ?? "{}") as Record<string, unknown>;
		},
		/** The lines of one tagged section of the material document the nth conversation call received. */
		section(call: number, name: string): string[] {
			return sectionLines(state.calls[call]!.messages[1]!.content, name);
		},
		/** The reference records of the nth conversation call: its `<now>` lines `資料 <source>: <json>`. */
		records(call: number): Array<Record<string, any> & { source: string }> {
			return sectionLines(
				state.calls[call]!.messages[2]!.content,
				"now",
			).flatMap((line) => {
				const match = /^資料 ([^:]+): (.*)$/.exec(line);
				return match
					? [
							{
								source: match[1]!,
								...(JSON.parse(match[2]!) as Record<string, any>),
							},
						]
					: [];
			});
		},
		answerText(runId: string) {
			const run = dialogue.get(runId)!;
			return run.answerMessageId
				? conversation.message(run.answerMessageId)!.text
				: null;
		},
	};
	return h;
}
export type Harness = Awaited<ReturnType<typeof setup>>;
