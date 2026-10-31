import { createHash } from "node:crypto";
import { withLogContext } from "../../../infrastructure/logger";
import type { LarmCallOptions, LarmPort } from "../contracts";
import { untilAborted } from "./guards";

/** Helper connections held at once; LARM admits only a few connections per profile. */
export const HELPER_CONNECTIONS = 2;

type Helper = {
	key: string;
	client: string;
	port: LarmPort;
	calls: number;
	usedAt: number;
};

/** The prefix LARM's cache can reuse: the first message and the tools. Non-text parts are not hashed whole. */
function prefixKey(
	messages: Parameters<LarmPort["answer"]>[0],
	options: LarmCallOptions,
) {
	const first = messages[0];
	const content =
		typeof first?.content === "string" ? first.content : "[non-text]";
	return createHash("sha256")
		.update(
			JSON.stringify([first?.role ?? null, content, options.tools ?? null]),
		)
		.digest("hex")
		.slice(0, 16);
}

/**
 * The connections of independent calls (auxiliary and task sub-agent calls). LARM keeps a connection's input
 * cache, so a call goes to an idle helper of its prefix (first message and tools). Otherwise it takes a free slot,
 * then the slot of the longest-unused idle helper (released first), then queues on a busy helper of its prefix,
 * and else waits until one is idle. A helper's client derives from the port's client and the prefix, so a
 * restarted host gets a still-live connection back. Each helper serves its calls in turn.
 */
export function createHelperConnections(
	create: (client: string) => LarmPort,
	client: string,
) {
	const helpers: Helper[] = [];
	let idle = new Set<() => void>();
	let closed = false;
	/** Releasing helpers still occupy LARM capacity, including for a different client. */
	const releasing = new Map<string, Promise<void>>();
	function released() {
		const waiting = idle;
		idle = new Set();
		for (const wake of waiting) wake();
	}
	function take(helper: Helper) {
		// Counted before the caller resumes, so no other acquirer can evict it in between.
		helper.calls++;
		helper.usedAt = Date.now();
		return helper;
	}
	async function acquire(key: string, signal: AbortSignal) {
		for (;;) {
			signal.throwIfAborted();
			if (closed) throw new Error("larm_closed");
			const own = helpers.filter((helper) => helper.key === key);
			const ready = own.find((helper) => !helper.calls);
			if (ready) return take(ready);
			if (releasing.size) {
				await untilAborted(Promise.race(releasing.values()), signal);
				continue;
			}
			if (helpers.length < HELPER_CONNECTIONS) {
				const used = new Set(own.map((helper) => helper.client));
				let n = 0;
				while (
					used.has(n ? `${client}-aux-${key}-${n}` : `${client}-aux-${key}`)
				)
					n++;
				const helperClient = n
					? `${client}-aux-${key}-${n}`
					: `${client}-aux-${key}`;
				const helper: Helper = {
					key,
					client: helperClient,
					port: create(helperClient),
					calls: 0,
					usedAt: Date.now(),
				};
				helpers.push(helper);
				return take(helper);
			}
			const [evicted] = helpers
				.filter((helper) => !helper.calls)
				.sort((a, b) => a.usedAt - b.usedAt);
			if (evicted) {
				helpers.splice(helpers.indexOf(evicted), 1);
				// Its release frees LARM's admission for the new prefix.
				const done = evicted.port
					.close()
					.catch(() => {})
					.finally(() => releasing.delete(evicted.client));
				releasing.set(evicted.client, done);
				continue;
			}
			const [queue] = own.sort((a, b) => a.calls - b.calls);
			if (queue) return take(queue);
			await untilAborted(new Promise<void>((wake) => idle.add(wake)), signal);
		}
	}
	return {
		/** `borrow` runs the call once a helper is held: waiting for a slot holds nothing else. */
		async answer(
			messages: Parameters<LarmPort["answer"]>[0],
			signal: AbortSignal,
			onDelta: ((text: string) => void) | undefined,
			options: LarmCallOptions,
			borrow: <T>(run: () => Promise<T>) => Promise<T>,
		) {
			const key = prefixKey(messages, options);
			return withLogContext({ sessionRole: options.sessionRole }, async () => {
				const helper = await acquire(key, signal);
				try {
					const call = { ...options, sessionRole: "main" as const };
					return await borrow(() =>
						onDelta
							? helper.port.answerStream!(messages, signal, onDelta, call)
							: helper.port.answer(messages, signal, call),
					);
				} finally {
					helper.calls--;
					helper.usedAt = Date.now();
					released();
				}
			});
		},
		async close(options?: { keepConnection?: true }) {
			closed = true;
			released();
			const all = helpers.splice(0);
			await Promise.all([
				...all.map((helper) => helper.port.close(options)),
				...releasing.values(),
			]);
		},
	};
}
