import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../conversation";
import { createQueue, migrations as queueMigrations } from "../../queue";
import {
	createDialogueService,
	migrations,
	type ToolchainRoutingPort,
} from "..";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import { analysisArgs } from "./analysis.fixture";

const own = z.object({ target: z.string(), when: z.string() }).strict();
export function card(id: string): ToolchainCard {
	return {
		id,
		revisionId: `toolchain:${id}@1`,
		functionName: `${id}_run`,
		title: id,
		summary: "対象と時点を指定して新しい情報を取得する",
		useWhen: ["対象の情報を取得する"],
		redirects: [],
		score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
		instant: {
			parameters: z.toJSONSchema(own) as Record<string, unknown>,
			parse: (input) => {
				const result = own.safeParse(input);
				return result.success
					? { ok: true, value: result.data }
					: { ok: false };
			},
		},
	};
}
type Script = {
	name: string;
	args?: Record<string, unknown>;
	during?: () => Promise<void>;
};
export async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-retained-"));
	const file = join(dir, "fixture.sqlite");
	const store = openStore(file, [
		...conversationMigrations,
		...queueMigrations,
		...migrations,
	]);
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const scripts: Script[] = [];
	const offered: Array<{
		tools: NativeTool[];
		messages: Array<{ role: string; content: string }>;
	}> = [];
	const executed: Array<{ revisionId: string; args: Record<string, unknown> }> =
		[];
	const cards = new Map(
		["weather", "stock", "calendar", "documents", "travel", "huge"].map(
			(id) => {
				const c = card(id);
				return [c.revisionId, c];
			},
		),
	);
	const traces = new Map<
		string,
		Parameters<ToolchainRoutingPort["recordSelectionInTransaction"]>[1]
	>();
	const searches: Parameters<ToolchainRoutingPort["routeInTransaction"]>[1][] =
		[];
	const embedded: string[] = [];
	const state = {
		matches: ["weather", "stock", "calendar", "documents", "travel"],
		embedding: true,
		instantAllowed: true,
		receiptAllowed: true,
	};
	const toolchains: ToolchainRoutingPort = {
		embedQuery: async (text) => {
			embedded.push(text);
			return state.embedding
				? ({
						space: {
							resourceId: "fixture",
							modelId: "fixture",
							dimension: 1,
							normalization: "l2",
						},
						vector: [1],
					} as never)
				: undefined;
		},
		cardInTransaction: (_db, id) => cards.get(id),
		catalogInTransaction: () =>
			[...cards.values()].map((c) => ({
				id: c.id,
				revisionId: c.revisionId,
				runtime: {
					execution: "instant",
					binding: {
						available: true,
						bindingRevisionId: "binding:fixture@1",
						adapterRef: "adapter:fixture@1",
					},
				},
			})),
		routeInTransaction: (_db, input) => {
			searches.push(input);
			return {
				cards: input.query
					? state.matches
							.flatMap((id) =>
								[...cards.values()].filter(
									(c) =>
										c.id === id && !input.excludeRevisionIds?.has(c.revisionId),
								),
							)
							.slice(0, 4)
					: [],
				past: [],
				retrieval: input.query ? "embedding" : "none",
			};
		},
		resolveInTransaction: (_db, id) => {
			if (!cards.has(id)) throw new Error("toolchain_unavailable");
			return {
				toolchain: {} as never,
				packageRevisionId: "package:fixture@1",
				runtime: { execution: "instant" },
			};
		},
		instantInTransaction: (_db, revisionId) => ({
			run: async (args) => {
				executed.push({ revisionId, args });
				if (!state.instantAllowed)
					return { ok: false, code: "temporary_failure" };
				return {
					ok: true,
					answer: `${String(args.target).slice(0, 100)}の${args.when}を新しく取得しました。`,
				};
			},
			fallback: null,
		}),
		commandSetInTransaction: () => {
			throw new Error("unexpected_command");
		},
		recordSelectionInTransaction: (_db, input) => {
			traces.set(input.runId, input);
			return input.runId;
		},
		requestOfRunInTransaction: (_db, id) => traces.get(id)?.request,
		linkTaskInTransaction: () => {},
		settleSelectionInTransaction: () => {},
	};
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		captureInTransaction: () => {},
		requestFor: () => "request",
		setContextPolicyInTransaction: () => {},
		snapshotInTransaction: () => ({ subagent: { resourceId: null } }),
		validateReceiptInTransaction: () => state.receiptAllowed,
		acceptInTransaction: () => state.receiptAllowed,
		acceptHostAnswerInTransaction: () => state.receiptAllowed,
		executeRequest: async () => {
			throw new Error("unexpected_request");
		},
		executeStream: async (
			_id: string,
			messages: Array<{ role: string; content: string }>,
			_signal: AbortSignal,
			_delta: unknown,
			_speech: unknown,
			tools: NativeTool[],
		) => {
			offered.push({ tools, messages });
			const script = scripts.shift();
			if (!script) throw new Error("fixture_script_missing");
			await script.during?.();
			if (script.name === "prose")
				return {
					value: "承知しました。",
					requestId: "request",
					attemptId: crypto.randomUUID(),
				} as Receipt;
			return {
				requestId: "request",
				attemptId: crypto.randomUUID(),
				value: "",
				toolCalls: [
					{
						id: "call",
						name: script.name,
						arguments: JSON.stringify({
							...analysisArgs({ kind: "live_info", freshness: "live" }),
							...script.args,
						}),
					},
				],
			} as Receipt;
		},
	} as unknown as InferencePort;
	const dialogue = createDialogueService({
		store,
		queue,
		conversation,
		larm,
		toolchains,
	});
	queue.start();
	const ask = async (text: string, conversationId = "main") => {
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId,
			text,
		});
		return (await dialogue.waitForTerminal(run.id, { timeoutMs: 3000 }))!;
	};
	const use = (id: string, target = "鎌倉", when = "明日") =>
		scripts.push({ name: `${id}_run`, args: { target, when } });
	const find = (query: string) =>
		scripts.push({ name: "find_toolchain", args: { query } });
	return {
		dir,
		file,
		store,
		conversation,
		queue,
		dialogue,
		toolchains,
		scripts,
		offered,
		executed,
		cards,
		traces,
		searches,
		embedded,
		state,
		ask,
		use,
		find,
		async close() {
			await dialogue.close();
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
