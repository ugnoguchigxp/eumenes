import { z } from "zod";
import type {
	HostKanbanCard,
	HostKanbanRun,
	HostMessage,
	HostRead,
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
	/^\/api\/toolchain-actions(\?status=unsettled)?$/,
	// The conversation the screen shows, and the task board's artifact and its board source.
	/^\/api\/conversations\/main$/,
	/^\/api\/toolchain-artifacts$/,
	/^\/api\/toolchain-artifacts\/artifact%3Akanban\.board%40[1-9][0-9]*\/sources\/kanban$/,
];

/** The only conversation the screen opens. */
const CONVERSATION = "main";
const MESSAGE_TEXT_LIMIT = 2000;
const BOARD_ARTIFACT = /^artifact:kanban\.board@([1-9][0-9]*)$/;

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
const conversationBody = z.looseObject({
	messages: z.array(
		z.looseObject({
			id: z.string(),
			role: z.enum(["user", "assistant"]),
			text: z.string(),
			createdAt: z.string(),
		}),
	),
});
const artifactList = z.looseObject({
	artifacts: z.array(z.looseObject({ artifactRevisionId: z.string() })),
});
const boardBody = z.looseObject({
	data: z.looseObject({
		cards: z.array(
			z.looseObject({
				id: z.string(),
				title: z.string(),
				column: z.enum(["todo", "running", "finished"]),
				revision: z.number(),
			}),
		),
		runs: z.array(
			z.looseObject({
				id: z.string(),
				cardId: z.string(),
				kind: z.string(),
				state: z.string(),
				origin: z.string(),
			}),
		),
	}),
});

/** The task board's artifact revision id: the highest registered `kanban.board` revision. */
export function boardArtifactOf(body: unknown): string | null {
	let best: { id: string; revision: number } | null = null;
	for (const a of artifactList.parse(body).artifacts) {
		const revision = Number(BOARD_ARTIFACT.exec(a.artifactRevisionId)?.[1]);
		if (revision && (!best || revision > best.revision))
			best = { id: a.artifactRevisionId, revision };
	}
	return best?.id ?? null;
}
export const boardSourcePath = (artifactRevisionId: string) =>
	`/api/toolchain-artifacts/${encodeURIComponent(artifactRevisionId)}/sources/kanban`;

export type HostReader = {
	get(path: string): Promise<unknown>;
	snapshot(seq: number, reads: readonly HostRead[]): Promise<HostSnapshot>;
};

export function createHostReader(options: {
	baseUrl: string;
	token?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
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
	async function messages(): Promise<HostMessage[]> {
		const parsed = conversationBody.parse(
			await get(`/api/conversations/${CONVERSATION}`),
		);
		return parsed.messages.map((m) => ({
			id: m.id,
			role: m.role,
			text: m.text.slice(0, MESSAGE_TEXT_LIMIT),
			createdAt: m.createdAt,
		}));
	}
	let board: string | null = null;
	async function kanban(): Promise<{
		cards: HostKanbanCard[];
		runs: HostKanbanRun[];
	}> {
		board ??= boardArtifactOf(await get("/api/toolchain-artifacts"));
		if (!board) throw new Error("kanban_board_unregistered");
		const { data } = boardBody.parse(await get(boardSourcePath(board)));
		return {
			cards: data.cards.map((c) => ({
				id: c.id,
				title: c.title,
				column: c.column,
				revision: c.revision,
			})),
			runs: data.runs.map((r) => ({
				id: r.id,
				cardId: r.cardId,
				kind: r.kind,
				state: r.state,
				origin: r.origin,
			})),
		};
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
				...(reads.includes("conversation")
					? { messages: await messages() }
					: {}),
				...(reads.includes("kanban") ? { kanban: await kanban() } : {}),
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
