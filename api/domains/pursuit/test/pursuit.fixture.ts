import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../../../application/migrations";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import { createCapabilities, hash } from "../../capabilities";
import { createQueue } from "../../queue";
import type { InferencePort, Receipt } from "../../inference";
import { createPursuit, type ResearchWebPort, type SourcePort } from "..";
import type { WebObservation } from "../contracts";
import { researchScript } from "./model.fixture";

export async function fixture(
	options: {
		consult?: boolean;
		sourceStart?: number;
		body?: string;
		unknownUsage?: boolean;
		holdModel?: Promise<void>;
		grader?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pursuit-")),
		path = join(dir, "db");
	let store = openStore(path, migrations),
		now = Date.now(),
		valid = true,
		calls = 0;
	const observations = new Map<string, WebObservation>(),
		cancelled = new Set<string>(),
		erased = new Set<string>(),
		notices: unknown[] = [];
	const gradePrompts: string[] = [];
	const modelPackets: Array<Record<string, any>> = [];
	const script = researchScript(options),
		receiptIds = new Set<string>();
	const inference: InferencePort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		async answer() {
			throw new Error("unexpected_fixture_answer");
		},
		async transcribe() {
			throw new Error("unexpected_fixture_transcription");
		},
		async speak() {
			throw new Error("unexpected_fixture_speech");
		},
		async close() {},
		captureUserControlInTransaction: () => crypto.randomUUID(),
		async executeControl(requestId, _messages, _signal, control) {
			calls++;
			modelPackets.push(JSON.parse(_messages.at(-1)!.content));
			if (
				(control?.outputSchema as { properties?: { passed?: unknown } })
					?.properties?.passed
			)
				gradePrompts.push(JSON.stringify(_messages));
			if (options.holdModel) await options.holdModel;
			const value = JSON.stringify(
				script(control!.outputSchema as Record<string, unknown>),
			);
			const attemptId = crypto.randomUUID();
			receiptIds.add(attemptId);
			return { requestId, attemptId, value };
		},
		usageOfInTransaction(_db, receipt: Receipt) {
			return receiptIds.has(receipt.attemptId)
				? {
						id: receipt.attemptId,
						requestId: receipt.requestId,
						subject: "fixture",
						purpose: "llm",
						source: "fixture",
						model: "fixture",
						status: "succeeded",
						reason: null,
						started: now,
						ended: now,
						accepted: 1,
						inputTokens: options.unknownUsage ? null : 10,
						outputTokens: options.unknownUsage ? null : 5,
					}
				: null;
		},
	};
	const source: SourcePort = {
		validSourceInTransaction: () => valid,
		validReferenceInTransaction: () => valid,
		controlSourceInTransaction: (_db, _conversation, messageId) => ({
			messageId,
			request: "2026年",
			digest: hash("2026年"),
		}),
		readReferenceInTransaction: () => "参考資料",
		deliverInTransaction: (_db, view) => {
			notices.push(view);
			return true;
		},
		revokeDeliveryInTransaction: () => {},
	};
	const web: ResearchWebPort = {
		startInTransaction(db, input) {
			const id = input.requestId;
			db.query("INSERT INTO fixture_web VALUES (?,?)").run(id, input.kind);
			observations.set(id, {
				state: "waiting",
				hits: [],
				documents: [],
				failures: [],
			});
			return { id, jobId: `web-${id}` };
		},
		current: (id) =>
			observations.get(id) ?? {
				state: "failed",
				hits: [],
				documents: [],
				failures: [],
				code: "fixture_missing",
			},
		cancelInTransaction: (_db, id) => {
			cancelled.add(id);
		},
		forgetInTransaction(db, id) {
			erased.add(id);
			db.query("DELETE FROM fixture_web WHERE id=?").run(id);
		},
		flush() {},
	};
	async function build() {
		const queue = createQueue(store, {
			pollMs: 2,
			resources: { "inference.llm": 1 },
			now: () => now,
		});
		const capabilities = createCapabilities(store, new Set(["pursuit"]), {
			bundleHost: offlineBundleHost,
		});
		await capabilities.seed();
		const service = createPursuit({
			store,
			queue,
			capabilities,
			inference,
			web,
			now: () => now,
		});
		service.configure(source);
		return { queue, service, capabilities };
	}
	await store.write((db) =>
		db.exec("CREATE TABLE fixture_web(id TEXT PRIMARY KEY,kind TEXT)"),
	);
	let running = await build();
	const request =
		"複数の資料を比較して根拠と反証を整理して fixture-private-marker";
	const execution = await store.write((db) =>
		running.service.task.startInTransaction(db, {
			source: {
				conversationId: "main",
				runId: "origin",
				messageId: "message",
				request,
				digest: hash(request),
			},
			request,
			references: [],
			toolchainRevisionId: "toolchain:web.research@4",
			bindingRevisionId: "binding:pursuit.research@2",
		}),
	);
	function start() {
		running.service.start();
		running.queue.start();
	}
	return {
		dir,
		gradePrompts,
		modelPackets,
		id: execution.id,
		notices,
		cancelled,
		erased,
		observations,
		start,
		store: () => store,
		service: () => running.service,
		queue: () => running.queue,
		capabilities: () => running.capabilities,
		view: () =>
			store.readSnapshot((db) =>
				running.service.task.viewInTransaction(db, execution.id),
			),
		calls: () => calls,
		invalidate: () => {
			valid = false;
		},
		advance: (ms: number) => {
			now += ms;
		},
		async restart() {
			await running.service.close();
			await running.queue.close(100);
			await store.close();
			store = openStore(path, migrations);
			running = await build();
			await running.queue.recover();
			await running.service.recover();
			start();
		},
		finishWeb() {
			for (const [id, value] of observations)
				if (value.state === "waiting") {
					const kind = store.read(
						(db) =>
							(
								db.query("SELECT kind FROM fixture_web WHERE id=?").get(id) as {
									kind: string;
								}
							).kind,
					);
					observations.set(id, {
						state: "finished",
						hits:
							kind === "lookup"
								? [
										{
											url: "https://example.com/source",
											title: "候補",
											snippet: "候補のみ",
										},
									]
								: [],
						documents:
							kind === "read"
								? [
										{
											url: "https://example.com/source",
											title: "一次資料",
											text: options.body ?? "本文で確認した事実",
											fetchedAt: new Date(now).toISOString(),
											truncated: false,
										},
									]
								: [],
						failures: [],
					});
				}
			return running.service.maintain();
		},
		async close() {
			await running.service.close();
			await running.queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
