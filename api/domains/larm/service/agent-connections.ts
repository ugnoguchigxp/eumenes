import { createHash } from "node:crypto";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { createLarm } from "./index";
import { createConversationYield } from "./conversation-yield";
import {
	createGenerationLanes,
	type GenerationLanes,
} from "./generation-lanes";

/** Role/identity comes from the host's agent ledger, never from messages or a LARM id. */
export function createAgentLarm(
	config: Parameters<typeof createLarm>[0],
	lanes: GenerationLanes = createGenerationLanes(),
): LarmPort {
	const root = createLarm(config);
	const client = config.client ?? crypto.randomUUID();
	const connections = new Map<string, LarmPort>();
	const lifetime = new AbortController();
	const listeners = new Set<() => void>();
	const yielding = createConversationYield();
	let selected: LarmPort | undefined;
	let retained = false;
	let closed = false;
	const notify = () => listeners.forEach((listener) => listener());
	root.onChange?.(notify);
	async function answer(
		messages: Parameters<LarmPort["answer"]>[0],
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		options: LarmCallOptions = {},
	) {
		if (closed) throw new Error("larm_closed");
		const role =
			options.sessionRole === "main" || options.onConversation ? "main" : "sub";
		const owner = options.agentSession ?? {
			conversationId: null,
			agentId: options.taskId ?? crypto.randomUUID(),
		};
		const key = JSON.stringify([
			role,
			owner.conversationId,
			owner.agentId,
			owner.branchId ?? null,
		]);
		let port = connections.get(key);
		if (!port) {
			const opaque = (purpose: string) =>
				createHash("sha256")
					.update(JSON.stringify([client, purpose, key]))
					.digest("hex");
			port = createLarm({
				...config,
				client: `eumenes-${opaque("connection").slice(0, 40)}`,
				connectionRole: role,
				promptCacheKey: opaque("prompt-cache"),
				keepAlive: role === "main" && config.keepAlive,
			});
			port.onChange?.(notify);
			connections.set(key, port);
			if (role === "main" && retained) port.retain?.(true);
		}
		if (role === "main") selected = port;
		const yields =
			options.onConversation || options.yields ? yielding.enter() : undefined;
		if (!yields) yielding.preempt();
		const scoped = AbortSignal.any([
			signal,
			lifetime.signal,
			...(yields ? [yields.signal] : []),
		]);
		const target = port;
		// The child already has its capacity. Its local main queue serializes this agent only.
		const call = { ...options, sessionRole: "main" as const };
		try {
			return await lanes[role](scoped, () =>
				onDelta && target.answerStream
					? target.answerStream(messages, scoped, onDelta, call)
					: target.answer(messages, scoped, call),
			);
		} finally {
			yields?.leave();
		}
	}
	return {
		...root,
		answer: (messages, signal, options) =>
			answer(messages, signal, undefined, options),
		answerStream: answer,
		connect: () => (selected ?? root).connect(),
		probe: (signal) => (selected ?? root).probe!(signal),
		llmContextWindow: () =>
			selected?.llmContextWindow?.() ?? root.llmContextWindow?.() ?? null,
		status: () => selected?.status() ?? root.status(),
		inspect: () =>
			selected?.inspect?.() ??
			root.inspect?.() ?? { profile: config.profile ?? "", providers: [] },
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		retain(active) {
			retained = active;
			root.retain?.(active);
			for (const [key, port] of connections)
				if (JSON.parse(key)[0] === "main") port.retain?.(active);
		},
		async close(options) {
			closed = true;
			lifetime.abort(new Error("larm_closed"));
			await Promise.all([
				root.close(options),
				...[...connections.values()].map((p) => p.close(options)),
			]);
			connections.clear();
			listeners.clear();
		},
	};
}
