import type { LlmPort, LlmRequest, ToolDefinition } from "eumenes-agency";
import { createSteeringInbox } from "eumenes-steer";
import { SET_QUIET, START_PREPARATION } from "eumenes-agency/agenda";
import { createAgencyStatePort } from "../../domains/dialogue";
import { createAlwaysOnHost } from "./always-on-host";
import { settle } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import type { imageFixture } from "../media/image.fixture";
import type { AgencyHostDeps, NoteDocumentPort } from "./host-types";
import { createContinuityService } from "../../domains/continuity";
import { createGoalsService } from "../../domains/goals";
import { createMemoryHostConnection } from "../memory-host";
import {
	createAgendaGoalStore,
	forgetGoalDocuments,
	goalForgetDeps,
} from "./goal-agenda";
import { join } from "node:path";

export type CallKind =
	| "plan"
	| "check"
	| "ask_check"
	| "compose"
	| "records"
	| "target"
	| "goal_mock"
	| "goal_verify";

/** Which of the agenda's four model calls a request is, by the call's own instruction. */
export function callKind(request: { system: string }): CallKind {
	if (request.system.includes("この呼び出しは「計画」")) return "plan";
	if (request.system.includes("調べものの重複チェック")) return "check";
	if (request.system.includes("質問の聞き直しチェック")) return "ask_check";
	if (request.system.includes("話す文を書く")) return "compose";
	if (request.system.includes("記録係")) return "records";
	if (request.system.includes("整理係")) return "target";
	if (request.system.includes("Claude Code モックです")) return "goal_mock";
	if (request.system.includes("模擬成果物を目標と設計書に照らして検査"))
		return "goal_verify";
	throw new Error("fixture_unknown_call");
}

export const noRecords = (): Record<
	"memories" | "candidates" | "plans" | "questions" | "conflicts",
	unknown[]
> => ({
	memories: [],
	candidates: [],
	plans: [],
	questions: [],
	conflicts: [],
});
export const planNothing = () => ({ add: [], drop: [], focus: "" });
export const composeDecline = () => ({
	utterance: null,
	emotion: null,
	decline: "fixture",
	questions: 0,
	choice: false,
});
export const composeSay = (utterance: string) => ({
	utterance,
	emotion: null,
	decline: null,
	questions: 0,
	choice: false,
});

const fallback = (kind: CallKind) =>
	kind === "plan"
		? planNothing()
		: kind === "check"
			? { verdict: "new", coveredBy: null, request: null, reason: "fixture" }
			: kind === "ask_check"
				? { verdicts: [] }
				: kind === "records"
					? noRecords()
					: kind === "target"
						? { targets: [], term: null }
						: composeDecline();

export async function agendaFixture(
	options: {
		/** The scripted model: the value each call returns (default: nothing to plan, nothing to say). */
		script?(
			kind: CallKind,
			request: LlmRequest<unknown>,
			n: number,
			signal: AbortSignal,
		): unknown | Promise<unknown>;
		media?: ReturnType<typeof imageFixture>;
		routeSpeech?: NonNullable<AgencyHostDeps["routeSpeechInTransaction"]>;
		steering?: boolean;
		webNote?: NonNullable<Parameters<typeof harness>[0]>["webNote"];
		dialogue?: Pick<
			NonNullable<Parameters<typeof harness>[0]>,
			"voiceText" | "firstRound"
		>;
		backgroundPaused?: AgencyHostDeps["backgroundPaused"];
		awaitingWorkConfirmation?: AgencyHostDeps["awaitingWorkConfirmation"];
		goals?: Pick<
			NonNullable<AgencyHostDeps["agendaGoals"]>,
			"designer" | "analysisMs" | "trace"
		>;
		/** How many looks find a shown note's document still being saved. */
		noteSavingPolls?: number;
	} = {},
) {
	let host: ReturnType<typeof createAlwaysOnHost>;
	const h = await harness({
		memory: true,
		resources: true,
		everyday: true,
		...(options.dialogue
			? {
					...options.dialogue,
					conversationAgent: {
						system: () => host.conversationAgent.system(),
						handsWork: () => host.conversationAgent.handsWork?.() ?? false,
						respond: (args) => host.conversationAgent.respond(args),
					},
				}
			: {}),
		...(options.webNote ? { webNote: options.webNote } : {}),
		...(options.media
			? { model: options.media.model, imageGateway: options.media.gateway }
			: {}),
	});
	const config = h.settings.get();
	config.agency.emotion = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: config.revision,
		settings: config,
		keys: [],
	});
	let now = Date.now(),
		serial = 0,
		published = 0,
		foreground = false;
	const goalsService = options.goals
		? createGoalsService(() => new Date(now).toISOString())
		: undefined;
	const goalStore = goalsService
		? createAgendaGoalStore(h.store, goalsService)
		: undefined;
	const memoryHost = options.goals
		? createMemoryHostConnection(h.memory!, h.dir)
		: undefined;
	const timers = new Map<number, { at: number; fn(): void }>();
	const requests: LlmRequest<unknown>[] = [];
	const kinds: CallKind[] = [];
	const signals: AbortSignal[] = [];
	const activities = new Set<() => void>();
	const steering = createSteeringInbox({ now: () => now });
	const port = createAgencyStatePort({
		agents: h.toolchain.agents,
		toolchains: h.routing,
		execution: () => h.executionPort,
		settings: h.settings,
		resources: h.resources,
		producesInTransaction: h.toolchain.capabilities.producesInTransaction,
		memory: h.memory!,
		now: () => now,
	});
	const catalogOf = (db: Parameters<typeof port.catalogInTransaction>[0]) =>
		port
			.catalogInTransaction(db)
			.filter(
				(c) =>
					!options.media || c.revisionId.startsWith("toolchain:image.create@"),
			);
	/** The Markdown domain's side of a shown note, in memory: saved after `noteSavingPolls` looks, then linked. */
	const documents = {
		started: [] as Array<{ id: string; title: string; markdown: string }>,
		originals: new Map<string, { title: string; markdown: string }>(),
		links: [] as Array<{ messageId: string; uri: string; label: string }>,
		forgotten: [] as string[],
		polls: new Map<string, number>(),
		failing: null as string | null,
	};
	const noteDocuments: NoteDocumentPort = {
		readInTransaction(_db, id) {
			return documents.forgotten.includes(id.replace(/^doc-/u, ""))
				? null
				: (documents.originals.get(id) ?? null);
		},
		startInTransaction(_db, note) {
			const id = `doc-${note.noteId}`;
			documents.originals.set(id, {
				title: note.title,
				markdown: note.markdown,
			});
			if (!documents.started.some((d) => d.id === id)) {
				documents.started.push({
					id,
					title: note.title,
					markdown: note.markdown,
				});
				documents.polls.set(id, options.noteSavingPolls ?? 0);
			}
			return id;
		},
		stateInTransaction(_db, id) {
			const left = documents.polls.get(id) ?? 0;
			if (left > 0) {
				documents.polls.set(id, left - 1);
				return "pending";
			}
			if (documents.failing) return { code: documents.failing };
			return {
				uri: `eumenes://markdown.document/generated-${id}`,
				label: documents.started.find((d) => d.id === id)!.title,
			};
		},
		linkInTransaction(_db, input) {
			documents.links.push({
				messageId: input.messageId,
				uri: input.uri,
				label: input.label,
			});
		},
		forget(_conversationId, noteIds) {
			documents.forgotten.push(...noteIds);
		},
	};
	// The harness keeps its continuity service to itself: this one reads and writes the same tables.
	const continuity = createContinuityService();
	const deps = {
		noteDocuments,
		store: h.store,
		conversation: h.conversation,
		settings: h.settings,
		memory: h.memory!,
		continuity,
		...(goalStore && goalsService && memoryHost
			? {
					agendaGoals: {
						...options.goals,
						...goalForgetDeps(goalsService),
						mockDir: join(h.dir, "goal-mock"),
						store: goalStore,
						readMemory: memoryHost.readForGoals,
						isGoalContextCurrent: memoryHost.isGoalContextCurrent,
					},
				}
			: {}),
		state: { ...port, catalogInTransaction: catalogOf },
		inference: {
			foregroundBusy: () => foreground,
			onActivity(listener: () => void) {
				activities.add(listener);
				return () => {
					activities.delete(listener);
				};
			},
		},
		createLlm: (
			next: Parameters<
				Parameters<typeof createAlwaysOnHost>[0]["createLlm"]
			>[0],
		): LlmPort => ({
			async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
				next(request as LlmRequest<unknown>);
				const kind = callKind(request);
				requests.push(request as LlmRequest<unknown>);
				kinds.push(kind);
				signals.push(signal);
				const value = await (options.script?.(
					kind,
					request as LlmRequest<unknown>,
					requests.length,
					signal,
				) ?? fallback(kind));
				signal.throwIfAborted();
				return {
					value: request.schema.parse(value),
					model: "fixture",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					latencyMs: 1,
				};
			},
		}),
		conversationBusy: () => false,
		backgroundPaused: options.backgroundPaused,
		awaitingWorkConfirmation: options.awaitingWorkConfirmation,
		recordSpokeInTransaction: () => {},
		publish: () => {
			published++;
		},
		nowMs: () => now,
		setTimer(fn: () => void, ms: number) {
			timers.set(++serial, { at: now + ms, fn });
			return serial;
		},
		clearTimer(id: unknown) {
			timers.delete(id as number);
		},
		...(options.steering === false ? {} : { steering }),
		...(options.media
			? {
					researchRevision: (catalog: ReadonlyArray<{ revisionId: string }>) =>
						catalog.find((c) =>
							c.revisionId.startsWith("toolchain:image.create@"),
						)?.revisionId,
				}
			: {}),
		...(options.routeSpeech
			? { routeSpeechInTransaction: options.routeSpeech }
			: {}),
	};
	if (goalStore)
		h.memory!.registerForgetPurge((db, purge) =>
			forgetGoalDocuments(
				db,
				goalStore,
				noteDocuments,
				h.memory!.referenceInputs,
				purge,
			),
		);
	host = createAlwaysOnHost(deps);
	h.memory!.registerForgetPurge(
		(db, p) => host.forgetInTransaction(db, p),
		(db, p) => host.planForgetInTransaction(db, p),
	);
	return {
		h,
		requests,
		kinds,
		signals,
		documents,
		goalStore,
		goalsService,
		memoryHost,
		port,
		deps,
		steering,
		get host() {
			return host;
		},
		get now() {
			return now;
		},
		/** How many times the host told the screens something changed outside a commit (its thoughts). */
		get published() {
			return published;
		},
		/** The calls of one kind, in order. */
		calls: (kind: CallKind) => requests.filter((_, i) => kinds[i] === kind),
		async start() {
			await memoryHost?.recover();
			await memoryHost?.listen();
			memoryHost?.start();
			await host.recover();
			host.start();
			await host.attend("ao");
			await settle();
		},
		async user(id: string, conversationId = "ao", text = `fixture ${id}`) {
			await h.store.write((db) =>
				h.conversation.appendInTransaction(db, {
					id,
					conversationId,
					role: "user",
					text,
					runId: null,
					createdAt: new Date(now).toISOString(),
				}),
			);
			await settle();
		},
		async assistant(id: string, text: string, conversationId = "ao") {
			await h.store.write((db) =>
				h.conversation.appendInTransaction(db, {
					id,
					conversationId,
					role: "assistant",
					text,
					runId: null,
					createdAt: new Date(now).toISOString(),
				}),
			);
			await settle();
		},
		async advance(ms = 10_000) {
			now += ms;
			for (const [id, timer] of Array.from(timers))
				if (timer.at <= now) {
					timers.delete(id);
					timer.fn();
				}
			await settle();
		},
		/** Whether the main conversation holds the model now (what `setBusy` set). */
		busy: () => foreground,
		setBusy(value: boolean) {
			foreground = value;
			for (const listener of activities) listener();
		},
		async restart() {
			await host.close();
			host = createAlwaysOnHost(deps);
			await host.recover();
			host.start();
			await settle();
		},
		async close() {
			await host.close();
			await memoryHost?.close();
			await h.close();
		},
	};
}

/** A reply of the conversation's agent that calls the given tools (one model call, then the answer). */
export async function replyWith(
	f: Awaited<ReturnType<typeof agendaFixture>>,
	tools: Array<{ name: string; arguments: Record<string, unknown> }>,
	options: {
		runId?: string;
		messageIds?: string[];
		host?: Pick<typeof f.host, "conversationAgent">;
		/** The host's own read tools: the names it offers (each answers `host tool`). */
		hostTools?: readonly string[];
	} = {},
) {
	let call = 0;
	const seen: Array<{ role: string; content: string }[]> = [];
	const toolDefinitions: ReadonlyArray<ToolDefinition>[] = [];
	const reply = await (options.host ?? f.host).conversationAgent.respond({
		run: {
			conversationId: "ao",
			runId: options.runId ?? "run-1",
			messageIds: options.messageIds ?? ["user-a"],
		},
		messages: [
			{ role: "system", content: "fixture system" },
			{ role: "user", content: "## User\nfixture user" },
		],
		chat: {
			async complete(request) {
				seen.push(request.messages.map((m) => ({ ...m })));
				toolDefinitions.push(request.tools);
				call++;
				return call === 1 && tools.length
					? {
							text: "",
							toolCalls: tools.map((t, i) => ({
								id: `call-${i}`,
								name: t.name,
								arguments: JSON.stringify(t.arguments),
							})),
						}
					: { text: "fixture answer", toolCalls: [] };
			},
		},
		tools: {
			tools: (options.hostTools ?? []).map((name) => ({
				name,
				description: name,
				parameters: { type: "object", properties: {} },
			})),
			call: async () => ({ content: "host tool" }),
		},
		signal: new AbortController().signal,
		onDelta: () => {},
		maxToolCalls: 0,
	});
	return {
		reply,
		seen,
		offered: toolDefinitions.map((tools) => tools.map((tool) => tool.name)),
		toolDefinitions,
	};
}

export const promiseResearch = [
	{ name: SET_QUIET, arguments: { scope: "all", kind: "said", minutes: 30 } },
	{
		name: START_PREPARATION,
		arguments: { request: "fixture promised research", askedByUser: true },
	},
];
