import { createHash } from "node:crypto";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { createLarm } from "./index";
import { createConversationYield } from "./conversation-yield";
import { untilAborted } from "./guards";
import {
	createGenerationLanes,
	type GenerationLanes,
} from "./generation-lanes";

type Owner = NonNullable<LarmCallOptions["agentSession"]>;
type Entry = {
	owner: Owner;
	role: "main" | "sub";
	client: string;
	port: LarmPort;
	calls: number;
	drained?: ReturnType<typeof Promise.withResolvers<void>>;
	retiring?: Promise<void>;
};

function createEntry(
	config: Parameters<typeof createLarm>[0],
	client: string,
	key: string,
	owner: Owner,
	role: Entry["role"],
): Entry {
	const opaque = (purpose: string) =>
		createHash("sha256")
			.update(JSON.stringify([client, purpose, key]))
			.digest("hex");
	const agentClient = `eumenes-${opaque("connection").slice(0, 40)}`;
	return {
		owner: { ...owner },
		role,
		client: agentClient,
		calls: 0,
		port: createLarm({
			...config,
			client: agentClient,
			llmConnection: undefined,
			connectionRole: role,
			promptCacheKey: opaque("prompt-cache"),
			keepAlive: role === "main" && config.keepAlive,
		}),
	};
}

/** Role/identity comes from the host's agent ledger, never from messages or a LARM id. */
export function createAgentLarm(
	config: Parameters<typeof createLarm>[0],
	lanes: GenerationLanes = createGenerationLanes(),
): LarmPort {
	const root = createLarm({ ...config, llmConnection: false });
	const client = config.client ?? crypto.randomUUID();
	const connections = new Map<string, Entry>();
	const lifetime = new AbortController();
	const listeners = new Set<() => void>();
	const yielding = createConversationYield();
	let selected: LarmPort | undefined;
	let retained = false;
	let closed = false;
	const notify = () =>
		listeners.forEach((listener) => {
			try {
				listener();
			} catch {
				/* Independent observers. */
			}
		});
	root.onChange?.(notify);
	function retire(key: string, entry: Entry) {
		if (!entry.retiring)
			entry.retiring = (async () => {
				if (entry.calls) await entry.drained?.promise;
				await entry.port.close();
				if (connections.get(key) === entry) connections.delete(key);
				notify();
			})();
		return entry.retiring;
	}
	async function answer(
		messages: Parameters<LarmPort["answer"]>[0],
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		options: LarmCallOptions = {},
	) {
		if (closed) throw new Error("larm_closed");
		const role =
			options.sessionRole === "main" || options.onConversation ? "main" : "sub";
		if (
			role === "main" &&
			(!options.agentSession?.conversationId || !options.agentSession.agentId)
		)
			throw new Error("larm_agent_identity_required");
		const owner = options.agentSession ?? {
			conversationId: null,
			agentId: options.taskId ?? crypto.randomUUID(),
		};
		if (options.independent && (role === "main" || options.yields))
			throw new Error("larm_independent_session_conflict");
		const key = JSON.stringify([
			role,
			owner.conversationId,
			owner.agentId,
			owner.branchId ?? null,
			...(options.independent ? ["independent"] : []),
		]);
		let entry = connections.get(key);
		if (entry?.retiring) {
			await untilAborted(
				entry.retiring,
				AbortSignal.any([signal, lifetime.signal]),
			);
			entry = connections.get(key);
		}
		if (!entry) {
			entry = createEntry(config, client, key, owner, role);
			entry.port.onChange?.(notify);
			connections.set(key, entry);
			if (role === "main" && retained) entry.port.retain?.(true);
		}
		if (!entry.calls) entry.drained = Promise.withResolvers<void>();
		entry.calls++;
		if (role === "main") selected = entry.port;
		const yields =
			options.onConversation || options.yields ? yielding.enter() : undefined;
		if (!yields && !options.independent) yielding.preempt();
		const scoped = AbortSignal.any([
			signal,
			lifetime.signal,
			...(yields ? [yields.signal] : []),
		]);
		const target = entry.port;
		// The child already has its capacity. Its local main queue serializes this agent only.
		const call = { ...options, sessionRole: "main" as const };
		try {
			return await lanes[options.independent ? "independent" : role](
				scoped,
				() =>
					onDelta && target.answerStream
						? target.answerStream(messages, scoped, onDelta, call)
						: target.answer(messages, scoped, call),
			);
		} finally {
			yields?.leave();
			entry.calls--;
			if (!entry.calls) entry.drained?.resolve();
			if (
				role === "sub" &&
				options.sessionRole !== "subagent" &&
				!options.independent
			)
				await retire(key, entry);
		}
	}
	return {
		...root,
		answer: (messages, signal, options) =>
			answer(messages, signal, undefined, options),
		answerStream: answer,
		async releaseTaskSession(taskId) {
			await Promise.all(
				[...connections]
					.filter(
						([, entry]) =>
							entry.role === "sub" && entry.owner.agentId === taskId,
					)
					.map(([key, entry]) => retire(key, entry)),
			);
		},
		connect: () => (selected ?? root).connect(),
		probe: (signal) => (selected ?? root).probe!(signal),
		llmContextWindow: () => selected?.llmContextWindow?.() ?? null,
		status: () => ({
			...(selected?.status() ?? root.status()),
			capabilities: [
				...new Set([
					...(selected?.status().capabilities ?? []),
					...root.status().capabilities,
				]),
			],
		}),
		inspect: () => {
			const main = selected?.inspect?.(),
				speech = root.inspect?.();
			return {
				...(main ?? speech ?? { profile: config.profile ?? "" }),
				decisionModel: speech?.decisionModel,
				providers: [
					...(main?.providers.filter((p) => p.name === "llm") ?? []),
					...(speech?.providers.filter((p) => !main || p.name !== "llm") ?? []),
				],
				agentConnections: [...connections.values()].map(
					({ owner, role, client, port }) => ({
						...owner,
						role,
						client,
						requestedTokens: role === "main" ? 200000 : 131072,
						connectionId: port.inspect?.().connectionId,
						bootEpoch: port.inspect?.().bootEpoch,
						state: port.status().state,
					}),
				),
			};
		},
		transcribe(wav, signal, options) {
			yielding.preempt();
			return root.transcribe(wav, signal, options);
		},
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		retain(active) {
			retained = active;
			root.retain?.(active);
			for (const { role, port } of connections.values())
				if (role === "main") port.retain?.(active);
		},
		async close(options) {
			closed = true;
			lifetime.abort(new Error("larm_closed"));
			await Promise.all([
				root.close(options),
				...[...connections.values()].map(({ port }) => port.close(options)),
			]);
			connections.clear();
			listeners.clear();
		},
	};
}
