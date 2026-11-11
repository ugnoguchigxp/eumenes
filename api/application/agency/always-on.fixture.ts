import type { LlmPort, LlmRequest } from "eumenes-agency";
import { createSteeringInbox } from "eumenes-steer";
import { SET_QUIET, START_PREPARATION } from "eumenes-agency/agenda";
import { createAgencyStatePort } from "../../domains/dialogue";
import { createAlwaysOnHost } from "./always-on-host";
import { createAgencyWork } from "./work";
import { settle } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import type { imageFixture } from "../media/image.fixture";
import type { AgencyHostDeps } from "./host-types";

export type CallKind = "plan" | "check" | "ask_check" | "compose" | "profile";

/** Which of the agenda's four model calls a request is, by the call's own instruction. */
export function callKind(request: { system: string }): CallKind {
	if (request.system.includes("この呼び出しは「計画」")) return "plan";
	if (request.system.includes("調べものの重複チェック")) return "check";
	if (request.system.includes("質問の聞き直しチェック")) return "ask_check";
	if (request.system.includes("話す文を書く")) return "compose";
	if (request.system.includes("メモ係")) return "profile";
	throw new Error("fixture_unknown_call");
}

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
				: kind === "profile"
					? { ops: [] }
					: composeDecline();

export async function agendaFixture(
	options: {
		/** The scripted model: the value each call returns (default: nothing to plan, nothing to say). */
		script?(
			kind: CallKind,
			request: LlmRequest<unknown>,
			n: number,
		): unknown | Promise<unknown>;
		media?: ReturnType<typeof imageFixture>;
		routeSpeech?: NonNullable<AgencyHostDeps["routeSpeechInTransaction"]>;
		steering?: boolean;
	} = {},
) {
	const h = await harness({
		memory: true,
		resources: true,
		everyday: true,
		...(options.media
			? { model: options.media.model, imageGateway: options.media.gateway }
			: {}),
	});
	const config = h.settings.get();
	config.agency.runtime = "always-on";
	config.agency.emotion = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: config.revision,
		settings: config,
		keys: [],
	});
	let now = Date.now(),
		serial = 0,
		foreground = false;
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
		store: h.store,
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
	const deps = {
		store: h.store,
		conversation: h.conversation,
		settings: h.settings,
		memory: h.memory!,
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
		recordSpokeInTransaction: () => {},
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
	let host = createAlwaysOnHost(deps);
	h.memory!.registerForgetPurge(
		(db, p) => host.forgetInTransaction(db, p),
		(db, p) => host.planForgetInTransaction(db, p),
	);
	return {
		h,
		requests,
		kinds,
		signals,
		port,
		deps,
		steering,
		get host() {
			return host;
		},
		get now() {
			return now;
		},
		/** The calls of one kind, in order. */
		calls: (kind: CallKind) => requests.filter((_, i) => kinds[i] === kind),
		async start() {
			await host.recover();
			host.attachWork(createAgencyWork({ dialogue: h.dialogue }));
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
	} = {},
) {
	let call = 0;
	const seen: Array<{ role: string; content: string }[]> = [];
	const offered: string[][] = [];
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
				offered.push(request.tools.map((t) => t.name));
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
			tools: [],
			call: async () => ({ content: "host tool" }),
		},
		signal: new AbortController().signal,
		onDelta: () => {},
		maxToolCalls: 0,
	});
	return { reply, seen, offered };
}

export const promiseResearch = [
	{ name: SET_QUIET, arguments: { scope: "all", kind: "said", minutes: 30 } },
	{
		name: START_PREPARATION,
		arguments: { request: "fixture promised research", askedByUser: true },
	},
];
