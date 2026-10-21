/** Shared fixture for the parent execution tests: a real store and queue with scripted model decisions. */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations } from "../repository";
import { hash, type ToolchainCard } from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { ChildResult, ToolchainExecutionPort } from "../../tool-runtime";
import { createTaskExecutions } from "../service/executions";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const clean of cleanups.splice(0)) await clean();
});
export type Call = { name: string; arguments: Record<string, unknown> };
export type DecisionContext = {
	results: Array<{ refs: string[] }>;
	plan: { revision: number; steps: Array<{ stepRef: string }> };
};
export const done = (summary = "confirmed"): ChildResult => ({
	state: "completed",
	ref: { id: "receipt" },
	summary,
	modelCalls: 1,
	references: [],
});
export function card(id: string): ToolchainCard {
	return {
		id,
		revisionId: `toolchain:${id}@1`,
		functionName: id,
		title: id,
		summary: id,
		useWhen: [id],
		avoidWhen: [],
		examples: [],
		redirects: [],
		score: { similarity: 1, ftsRank: null, history: false },
	} as unknown as ToolchainCard;
}
export async function setup(
	calls: Array<Call | ((context: DecisionContext) => Call)>,
	initial = done(),
	defer = false,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-execution-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store);
	const observed: Array<{ tools: string[]; context: string }> = [];
	const children: import("../../tool-runtime").ChildExecution[] = [];
	let count = 0,
		dispatches = 0,
		cancels = 0,
		searches = 0,
		valid = true,
		result = initial;
	const inference = {
		captureUserControlInTransaction: () => crypto.randomUUID(),
		acceptInTransaction: () => true,
		executeStream: async (
			requestId: string,
			messages: Array<{ content: string }>,
			_signal: AbortSignal,
			_delta: unknown,
			_prep: unknown,
			tools: Array<{ function: { name: string } }>,
		) => {
			observed.push({
				tools: tools.map((t) => t.function.name),
				context: messages.at(-1)!.content,
			});
			const decision = calls[count++];
			if (!decision) throw new Error("fixture_calls_exhausted");
			const call =
				typeof decision === "function"
					? decision(JSON.parse(messages.at(-1)!.content))
					: decision;
			return {
				requestId,
				attemptId: crypto.randomUUID(),
				value: "",
				toolCalls: [
					{
						id: crypto.randomUUID(),
						name: call.name,
						arguments: JSON.stringify(call.arguments),
					},
				],
			} as Receipt;
		},
	} as unknown as InferencePort;
	const runtime = createTaskExecutions({
		store,
		queue,
		inference,
		now: Date.now,
	});
	const cards = [card("lookup"), card("operate")];
	const port: ToolchainExecutionPort = {
		validSourceInTransaction: () => valid,
		validReferenceInTransaction: () => valid,
		controlSourceInTransaction: (_db, _conversationId, messageId) => ({
			messageId,
			request: "updated request",
			digest: hash("updated request"),
		}),
		readReferenceInTransaction: (_db, _source, ref, start, limit) =>
			ref.preview.slice(start, start + limit),
		cardInTransaction: (_db, revision) =>
			cards.find((c) => c.revisionId === revision),
		find: async () => {
			searches++;
			return cards;
		},
		prepareInTransaction: () => null,
		execute: async (_prepared, child) => {
			children.push(structuredClone(child));
			dispatches++;
			return result;
		},
		currentInTransaction: () => result,
		adoptInTransaction: () => valid,
		cancelInTransaction: () => {
			cancels++;
			result = { ...result, state: "cancelled" };
		},
		validateAnswerInTransaction: (_db, _child, _result, input) =>
			typeof input === "string",
		flush: () => {},
		deliverInTransaction: () => true,
		controlInTransaction: () => ({
			revisionId: "binding:task.execute@1",
			instructions: "fixture",
			runMs: 300_000,
			limits: { parentCalls: 12, childCalls: 6, searches: 3, modelCalls: 48 },
		}),
	};
	runtime.configure(port);
	const source = {
		conversationId: "conversation",
		messageId: "message",
		runId: "real-source-run",
		request: "find an item and use the result",
		digest: hash("find an item and use the result"),
	};
	const start = () =>
		store.write((db) =>
			runtime.startInTransaction(db, {
				source,
				request: source.request,
				references: [],
			}),
		);
	const get = (id: string) =>
		store.read((db) => runtime.viewInTransaction(db, id)!);
	const control = (id: string, action: string, extra = {}) =>
		store.write((db) =>
			runtime.controlInTransaction(
				db,
				source.conversationId,
				{ workRef: id, expectedRevision: get(id).revision, action, ...extra },
				"answer-message",
			),
		);
	cleanups.push(async () => {
		await runtime.close();
		await queue.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const run = () => {
		runtime.start();
		queue.start();
	};
	if (!defer) run();
	return {
		store,
		inference,
		port,
		run,
		source,
		children,
		runtime,
		queue,
		start,
		get,
		control,
		observed,
		stats: () => ({ count, dispatches, cancels, searches }),
		setResult: (r: ChildResult) => {
			result = r;
		},
		invalidate: () => {
			valid = false;
		},
	};
}
export const finish = (context: DecisionContext): Call => ({
	name: "complete_task",
	arguments: {
		summary: "All confirmed",
		fulfilled: ["done"],
		missing: [],
		refs: context.results.flatMap((result) => result.refs),
	},
});
export const plan = (...requests: string[]): Call => ({
	name: "set_plan",
	arguments: {
		goal: requests.join(" / "),
		items: requests.map((request, index) => ({
			request,
			check: "",
			dependsOn: index ? [index - 1] : [],
		})),
		report: "summarize the results",
	},
});
export const invoke =
	(name: string, index = 0, contextRefs: string[] = []) =>
	(context: DecisionContext): Call => ({
		name,
		arguments: { stepRef: context.plan.steps[index]!.stepRef, contextRefs },
	});
