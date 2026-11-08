import type { LlmPort, LlmRequest, ThinkOutput } from "eumenes-agency";
import { createAgencyStatePort } from "../../domains/dialogue";
import { createAlwaysOnHost } from "./always-on-host";
import { createAgencyWork } from "./work";
import { settle } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import type { imageFixture } from "../media/image.fixture";

export const thinkWait = (): ThinkOutput => ({
	thought: "fixture thought",
	drive: "presence",
	userOps: [],
	stockOps: [],
	pace: { op: "none", minutes: null, evidenceRefs: [] },
	action: {
		kind: "wait",
		utterance: null,
		toolName: null,
		toolInput: null,
		evidenceRefs: [],
	},
	next: "normal",
});

export async function alwaysOnFixture(
	options: {
		reply?(
			request: LlmRequest<unknown>,
			n: number,
		): ThinkOutput | Promise<ThinkOutput>;
		media?: ReturnType<typeof imageFixture>;
		routeSpeech?: () => boolean;
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
	const signals: AbortSignal[] = [];
	const activities = new Set<() => void>();
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
	const deps = {
		store: h.store,
		conversation: h.conversation,
		settings: h.settings,
		memory: h.memory!,
		state: {
			...port,
			catalogInTransaction: (
				db: Parameters<typeof port.catalogInTransaction>[0],
			) =>
				port
					.catalogInTransaction(db)
					.filter(
						(c) =>
							!options.media ||
							c.revisionId.startsWith("toolchain:image.create@"),
					),
		},
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
				requests.push(request as LlmRequest<unknown>);
				signals.push(signal);
				const value = await (options.reply?.(
					request as LlmRequest<unknown>,
					requests.length,
				) ?? thinkWait());
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
		signals,
		port,
		deps,
		get host() {
			return host;
		},
		async start() {
			await host.recover();
			host.attachWork(createAgencyWork({ dialogue: h.dialogue }));
			host.start();
			await host.attend("ao");
			await settle();
		},
		async user(id: string, conversationId = "ao") {
			await h.store.write((db) =>
				h.conversation.appendInTransaction(db, {
					id,
					conversationId,
					role: "user",
					text: `fixture ${id}`,
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
