import { z } from "zod";
import type {
	HostInteraction,
	HostSnapshot,
	HostTimer,
	ObservedReceipt,
} from "./types";

/**
 * Readonly access to the product host for the judge. The reader has no write method and
 * refuses any path outside the allowlist, so a bug in the runner cannot change host state.
 */
const READABLE = [
	/^\/api\/timers(\?[A-Za-z0-9=&.%_-]*)?$/,
	/^\/api\/timers\/[0-9a-f-]{36}$/,
	/^\/api\/timer-actions\/by-run\/[A-Za-z0-9_-]{1,128}$/,
	/^\/api\/toolchain-interactions(\?[A-Za-z0-9=&.%_-]*)?$/,
	/^\/api\/toolchain-actions(\?status=unsettled)?$/,
];

const timerItem = z.looseObject({
	id: z.string(),
	revision: z.number(),
	state: z.enum(["active", "paused", "elapsed", "cancelled"]),
	label: z.string(),
	durationSeconds: z.number(),
	dueAt: z.string(),
	remainingSeconds: z.number(),
	originRunId: z.string().nullable().optional(),
});
const timerPage = z.looseObject({
	serverNow: z.string(),
	items: z.array(timerItem),
	nextCursor: z.string().nullable().optional(),
});
const interactionItem = z.looseObject({
	id: z.string(),
	status: z.string(),
	questionCount: z.number().optional(),
	receiptRef: z.unknown().optional(),
});

export type HostReader = {
	get(path: string): Promise<unknown>;
	snapshot(
		seq: number,
		reads: readonly ("timers" | "interactions")[],
	): Promise<HostSnapshot>;
};

export function createHostReader(options: {
	baseUrl: string;
	token?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	conversationId?: string;
}): HostReader {
	const send = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	async function get(path: string): Promise<unknown> {
		if (!READABLE.some((pattern) => pattern.test(path)))
			throw new Error("host_read_not_allowed");
		const response = await send(new URL(path, options.baseUrl), {
			method: "GET",
			redirect: "error",
			headers: options.token
				? { authorization: `Bearer ${options.token}` }
				: undefined,
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`host_read_status_${response.status}`);
		return response.json();
	}
	async function timers(): Promise<{
		serverNowMs: number;
		items: HostTimer[];
	}> {
		const items: HostTimer[] = [];
		let cursor: string | null | undefined;
		let serverNowMs = 0;
		for (let page = 0; page < 5; page++) {
			const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
			const parsed = timerPage.parse(await get(`/api/timers?${query}`));
			serverNowMs = Date.parse(parsed.serverNow);
			for (const t of parsed.items)
				items.push({
					id: t.id,
					revision: t.revision,
					state: t.state,
					label: t.label,
					durationSeconds: t.durationSeconds,
					dueAt: t.dueAt,
					remainingSeconds: t.remainingSeconds,
					originRunId: t.originRunId ?? null,
				});
			cursor = parsed.nextCursor;
			if (!cursor) break;
		}
		return { serverNowMs, items };
	}
	async function interactions(): Promise<HostInteraction[] | null> {
		try {
			const raw = await get(
				`/api/toolchain-interactions?conversationId=${options.conversationId ?? "main"}`,
			);
			const list = Array.isArray(raw)
				? raw
				: ((raw as { items?: unknown[] })?.items ?? null);
			if (!list) return null;
			return list.map((x) => {
				const i = interactionItem.parse(x);
				return {
					id: i.id,
					status: i.status,
					questionCount: i.questionCount ?? 0,
					hasReceiptRef: i.receiptRef != null,
				};
			});
		} catch {
			return null;
		}
	}
	return {
		get,
		async snapshot(seq, reads) {
			const atMs = now();
			const t = reads.includes("timers")
				? await timers()
				: { serverNowMs: atMs, items: [] };
			return {
				seq,
				atMs,
				serverNowMs: t.serverNowMs,
				timers: t.items,
				interactions: reads.includes("interactions")
					? await interactions()
					: null,
			};
		},
	};
}

/** Finds timer_action receipts anywhere in a JSON body (depth-limited). */
export function scanReceipts(
	body: unknown,
	atMs: number,
	httpStatus: number,
): ObservedReceipt[] {
	const found: ObservedReceipt[] = [];
	const visit = (value: unknown, depth: number) => {
		if (depth > 6 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const v of value) visit(v, depth + 1);
			return;
		}
		const o = value as Record<string, unknown>;
		if (
			o.kind === "timer_action" &&
			typeof o.action === "string" &&
			typeof o.operationId === "string"
		) {
			const timer = o.timer as { id?: unknown; revision?: unknown } | undefined;
			const artifact = o.artifact as { timerId?: unknown } | undefined;
			found.push({
				atMs,
				action: o.action,
				operationId: o.operationId,
				timerId:
					typeof timer?.id === "string"
						? timer.id
						: typeof artifact?.timerId === "string"
							? artifact.timerId
							: null,
				revision: typeof timer?.revision === "number" ? timer.revision : null,
				httpStatus,
			});
			return;
		}
		for (const v of Object.values(o)) visit(v, depth + 1);
	};
	visit(body, 0);
	return found;
}
