import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { LlmRequest, LlmPort, AgencySnapshot } from "eumenes-agency";
import { createConversationService } from "../../domains/conversation";
import { createContinuityService } from "../../domains/continuity";
import { createMemoryService } from "../../domains/memory";
import { createAgencyStatePort } from "../../domains/dialogue";
import { openDialogueStore } from "../../domains/dialogue/test/store.fixture";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { createAgencyHost } from "./host";
import { baseSettings, choice, updated } from "./host.fixture";
import { saveItem } from "../../domains/memory/test/memory.fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(onSelect?: () => Promise<void>) {
	const { dir, store } = openDialogueStore("agency-memory-integration-");
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const continuity = createContinuityService();
	let now = Date.now();
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: join(dir, "forget.jsonl"),
		clock: () => new Date(now).toISOString(),
	});
	await memory.recover();
	const state = createAgencyStatePort({ now: () => now, memory });
	const calls: Array<Omit<LlmRequest<unknown>, "schema">> = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>) {
			const { schema: _schema, ...captured } = request;
			calls.push(structuredClone(captured));
			if (request.purpose === "select") await onSelect?.();
			const data = JSON.parse(request.prompt);
			const refs: string[] = data.conversationEvidenceRefs ?? [];
			const raw =
				request.purpose === "update"
					? updated()
					: choice("speak", {
							refs: [refs.at(-1)!],
							utterance: "この話には別の見方もありそうですね。",
						});
			return {
				value: request.schema.parse(raw),
				model: "fixture",
				inputTokens: 10,
				outputTokens: 10,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	const hosts: ReturnType<typeof createAgencyHost>[] = [];
	function start(activate = true) {
		const persona = {
			agentName: "Eumenes",
			userName: "",
			persona: "butler" as const,
		};
		const host = createAgencyHost({
			store,
			conversation,
			memory,
			state,
			settings: {
				get: () => ({ agency: baseSettings, general: persona }),
				inTransaction: () => ({ agency: baseSettings, general: persona }),
				onChange: () => () => {},
			},
			inference: { foregroundBusy: () => false },
			conversationBusy: () => false,
			recordSpokeInTransaction: () => {},
			createLlm: () => llm,
			nowMs: () => now,
		});
		memory.registerForgetPurge(
			host.forgetInTransaction,
			host.planForgetInTransaction,
		);
		if (activate) host.start();
		hosts.push(host);
		return host;
	}
	cleanups.push(async () => {
		for (const host of hosts) await host.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	async function exchange(
		id: string,
		conversationId: string,
		text: string,
		waitSpeech = true,
	) {
		now += 70_000;
		const runId = `run:${id}`;
		const before = conversation
			.get(conversationId)
			.messages.filter((m) => m.id.startsWith("agency:")).length;
		await conversation.append({
			id,
			conversationId,
			role: "user",
			text,
			runId: null,
			createdAt: new Date(now).toISOString(),
		});
		await store.write((db) =>
			memory.referenceInputs.recordRunInTransaction(
				db,
				runId,
				memory.referenceInputs.captureInTransaction(db, { messageIds: [id] }),
			),
		);
		await conversation.append({
			id: `reply:${id}`,
			conversationId,
			role: "assistant",
			text: "なるほど。",
			runId,
			createdAt: new Date(now).toISOString(),
		});
		if (waitSpeech)
			await waitFor(
				() =>
					conversation
						.get(conversationId)
						.messages.filter((m) => m.id.startsWith("agency:")).length > before,
			);
		await settle();
	}
	return {
		store,
		conversation,
		memory,
		state,
		calls,
		start,
		exchange,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("an untraceable reply after forgetting does not block independent autonomous decisions", async () => {
	const h = await fixture();
	let host = h.start();
	await h.exchange("forget-seed", "seed", "忘却する会話材料");
	expect(
		(
			await h.memory.forget({
				conversationId: "seed",
				messageIds: ["forget-seed"],
				itemIds: [],
			})
		).completed,
	).toBe(true);
	await h.conversation.append({
		id: "untraceable-reply",
		conversationId: "B",
		role: "assistant",
		text: "出所を追跡できない古い応答",
		runId: "unrecorded-run",
		createdAt: new Date(h.now()).toISOString(),
	});
	await h.exchange("independent-input", "B", "新しい独立した関心です", false);
	await settle();
	expect(
		host.inspect("B")!.snapshot.observations.map((o) => o.id),
	).not.toContain("untraceable-reply");
	expect(
		h.calls.some(
			(r) =>
				r.purpose === "select" &&
				JSON.parse(r.prompt).conversationEvidenceRefs.includes(
					"independent-input",
				),
		),
	).toBe(true);
	expect(h.calls.at(-1)?.input?.complete).toBe(true);
	await host.close();
	host = h.start();
	await h.exchange("after-restart", "B", "再開後も関心を続けます");
	expect(JSON.stringify(h.calls)).not.toContain("出所を追跡できない古い応答");
});

test("candidate-free speech reaches the real host writer and Memory-backed checkpoint", async () => {
	const h = await fixture();
	const host = h.start();
	await h.exchange("uB", "B", "話を続けるための新しい材料です。");
	const snapshot = host.inspect("B")!.snapshot;
	expect(snapshot.state.candidates).toHaveLength(0);
	expect(snapshot.state.attempts[0]?.candidateId).toBeNull();
	expect(h.calls.some((r) => r.purpose === "select")).toBe(true);
	expect(h.calls.every((r) => r.input?.complete)).toBe(true);
	const raw = h.store.read((db) =>
		db
			.query(
				"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id='B'",
			)
			.get(),
	) as { snapshot_json: string };
	expect(raw.snapshot_json).not.toContain("話を続けるための新しい材料です。");
	expect(
		h.store.read((db) => h.state.observationsInTransaction(db, "B")).length,
	).toBeGreaterThan(0);
});

test("forget removes A bodies and preserves independent B through result persistence and restart", async () => {
	const h = await fixture();
	let host = h.start();
	await h.exchange("uA", "A", "Aだけに関係する忘却対象の情報");
	await h.exchange("uB", "B", "Bだけに関係する独立した情報");
	const scope = h.store.read(
		(db) =>
			h.state.recordsInTransaction(db).find((r) => r.conversationId === "B")!
				.scope,
	);
	const erased = h.store
		.read((db) => h.state.observationsInTransaction(db, "A"))
		.map((row) => row.ref);
	const result = await h.memory.forget({
		conversationId: "A",
		messageIds: ["uA"],
		itemIds: [],
	});
	expect(result.completed).toBe(true);
	await settle();
	for (const ref of erased)
		expect(
			h.store.read((db) =>
				h.memory.referenceInputs.readRecordInTransaction(db, {
					recordId: ref.id,
					revision: ref.revision,
				}),
			),
		).toBeNull();
	expect(h.conversation.message("uA")?.text).toBe(
		"Aだけに関係する忘却対象の情報",
	);
	expect(
		host
			.inspect("A")
			?.snapshot.observations.some((o) => o.text.includes("忘却対象")),
	).toBe(false);
	expect(
		h.store.read(
			(db) =>
				h.state.recordsInTransaction(db).find((r) => r.conversationId === "B")!
					.scope,
		),
	).toBe(scope);
	expect(
		host.inspect("B")!.snapshot.observations.some((o) => o.id === "uB"),
	).toBe(true);
	await host.close();
	host = h.start();
	expect(
		host.inspect("B")!.snapshot.observations.find((o) => o.id === "uB")?.text,
	).toBe("Bだけに関係する独立した情報");
	await h.exchange("uB2", "B", "新しい独立した会話を続けます。");
	expect(h.calls.at(-1)?.input?.complete).toBe(true);
});

test("uncited Memory topics invalidate their outputs, then unrelated conversation can speak again", async () => {
	const h = await fixture();
	await h.conversation.append({
		id: "seed",
		conversationId: "seed",
		role: "user",
		text: "紅茶の匂いが好き",
		runId: null,
		createdAt: new Date().toISOString(),
	});
	const item = await saveItem(h.store, h.memory, {
		conversationId: "seed",
		messageId: "seed",
		kind: "preference",
		semanticKey: "drink.preference",
		text: "紅茶の匂いが好き",
	});
	const host = h.start();
	await h.exchange("uB", "B", "今日の会話を続けましょう。");
	const selected = h.calls.find((r) => r.purpose === "select")!;
	expect(selected.input?.sources).toContain(`memory:${item.id}`);
	expect(JSON.parse(selected.prompt).topics).toContainEqual(
		expect.objectContaining({ id: item.id }),
	);
	const result = await h.memory.forget({
		conversationId: "seed",
		messageIds: [],
		itemIds: [item.id],
	});
	expect(result.completed).toBe(true);
	expect(host.inspect("B")!.snapshot.state.attempts).toHaveLength(0);
	expect(
		host.inspect("B")!.snapshot.observations.some((o) => o.id === "uB"),
	).toBe(true);
	await h.exchange("uB2", "B", "別の新しい材料で会話を続けます。");
	expect(h.calls.at(-1)!.input?.sources).not.toContain(`memory:${item.id}`);
	expect(h.calls.at(-1)!.input?.complete).toBe(true);
});

test("legacy checkpoints are quarantined before new work, and shutdown confirms that quarantine", async () => {
	const h = await fixture();
	let host = h.start();
	await h.exchange("old", "B", "旧入力");
	await host.close();
	const before = h.store.read((db) => h.state.recordsInTransaction(db)[0]!);
	await h.store.write((db) => {
		const { provenance: _provenance, ...snapshot } = structuredClone(
			before.snapshot,
		) as AgencySnapshot;
		expect(
			h.state.saveInTransaction(db, { ...before, snapshot }, Date.now()),
		).toBe(true);
	});
	host = h.start(false);
	await host.recover();
	expect(h.store.read((db) => h.state.recordsInTransaction(db))).toEqual([]);
	expect(h.store.read((db) => h.state.epochInTransaction(db, "B"))).toBe(
		before.epoch + 1,
	);
	host.start();
	await h.exchange("new-after-legacy", "B", "新しい入力");
	expect(
		host.inspect("B")!.snapshot.observations.some((o) => o.id === "old"),
	).toBe(false);
	await host.close();
	expect(h.store.read((db) => h.state.epochInTransaction(db, "B"))).toBe(
		before.epoch + 1,
	);
	expect(
		h.store.read((db) => h.state.recordsInTransaction(db)[0]!.scope),
	).not.toBe(before.scope);
	expect(h.conversation.message("old")?.text).toBe("旧入力");
});

test("compacted observations remain in Memory, restore with bounded live state, and accept new conversation", async () => {
	const h = await fixture();
	let host = h.start();
	await h.store.write((db) => {
		for (let n = 0; n < 40; n++) {
			const user = `burst-user-${n}`,
				run = `burst-run-${n}`;
			h.conversation.appendInTransaction(db, {
				id: user,
				conversationId: "B",
				role: "user",
				text: `会話材料 ${n}`,
				runId: null,
				createdAt: new Date().toISOString(),
			});
			h.memory.referenceInputs.recordRunInTransaction(
				db,
				run,
				h.memory.referenceInputs.captureInTransaction(db, {
					messageIds: [user],
				}),
			);
			h.conversation.appendInTransaction(db, {
				id: `burst-agent-${n}`,
				conversationId: "B",
				role: "assistant",
				text: `返事 ${n}`,
				runId: run,
				createdAt: new Date().toISOString(),
			});
		}
	});
	await waitFor(() => (host.inspect("B")?.snapshot.cursor ?? 0) >= 80);
	await settle();
	await host.close();
	const saved = h.store.read(
		(db) => h.state.recordsInTransaction(db)[0]!.snapshot,
	) as AgencySnapshot;
	expect(saved.compactedThrough).toBeGreaterThan(0);
	expect(saved.observations.length).toBeLessThan(80);
	const archived = h.store.read((db) =>
		h.state
			.observationsInTransaction(db, "B")
			.find((r) => r.observationId === "burst-user-0"),
	)!;
	expect(
		h.store.read((db) =>
			h.memory.referenceInputs.readRecordInTransaction(db, {
				recordId: archived.ref.id,
				revision: archived.ref.revision,
			}),
		)?.content,
	).toContain("会話材料 0");
	host = h.start();
	expect(host.inspect("B")!.snapshot.compactedThrough).toBe(
		saved.compactedThrough,
	);
	await h.exchange("after-compaction", "B", "圧縮後も会話を続けます");
	expect(h.calls.at(-1)!.input?.complete).toBe(true);
});

test("Memory expiry during selection rejects the old output and new conversation recovers", async () => {
	let release!: () => void,
		selected = false;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await fixture(async () => {
		selected = true;
		await gate;
	});
	await h.conversation.append({
		id: "expiry-seed",
		conversationId: "seed",
		role: "user",
		text: "期限付きの好み",
		runId: null,
		createdAt: new Date(h.now()).toISOString(),
	});
	const item = await saveItem(h.store, h.memory, {
		conversationId: "seed",
		messageId: "expiry-seed",
		kind: "preference",
		semanticKey: "temporary.preference",
		text: "期限付きの好み",
		validUntil: new Date(h.now() + 86_400_000).toISOString().slice(0, 10),
	});
	h.start();
	await h.exchange("before-expiry", "B", "新しい話題です", false);
	await waitFor(() => selected, { timeout: 1000 });
	expect(h.calls.at(-1)?.input?.sources).toContain(`memory:${item.id}`);
	let rejected = false;
	const check = h.memory.referenceInputs.isCurrentInTransaction;
	h.memory.referenceInputs.isCurrentInTransaction = (db, input) => {
		const current = check(db, input);
		if (!current && input.sources.includes(`memory:${item.id}`))
			rejected = true;
		return current;
	};
	h.advance(item.validUntilMs! - h.now() + 1);
	release();
	await waitFor(() => rejected, { timeout: 1000 });
	await settle();
	expect(
		h.conversation.get("B").messages.filter((m) => m.id.startsWith("agency:")),
	).toHaveLength(0);
	await h.exchange("after-expiry", "B", "新しい独立した話です");
	expect(h.calls.at(-1)?.input?.sources).not.toContain(`memory:${item.id}`);
});

for (const loss of [
	"forgotten-message",
	"forgotten-message-with-record-ref",
	"forgotten-record",
	"forgotten-record-without-ref-or-provenance",
	"forgotten-receipt-without-ref-or-provenance",
	"unknown-missing",
	"unknown-missing-without-ref-or-provenance",
] as const) {
	test(`startup reconciles confirmed forgetting but preserves failures for ${loss}`, async () => {
		const h = await fixture();
		let host = h.start();
		await h.exchange("lost-input", "A", "復元してはならない観測本文");
		await h.exchange("kept-input", "B", "独立した会話の観測本文");
		await host.close();
		const records = h.store.read((db) => h.state.recordsInTransaction(db));
		const before = records.find((r) => r.conversationId === "A")!;
		const kept = records.find((r) => r.conversationId === "B")!;
		const receipt = loss.startsWith("forgotten-receipt");
		const observationId = receipt
			? (before.snapshot as AgencySnapshot).observations.find(
					(o) => o.kind === "delivery.observed",
				)!.id
			: "lost-input";
		const independentReceipt = receipt
			? (kept.snapshot as AgencySnapshot).observations.find(
					(o) => o.id === observationId,
				)
			: undefined;
		if (receipt) expect(independentReceipt?.text.length).toBeGreaterThan(0);
		const row = h.store.read((db) =>
			h.state
				.observationsInTransaction(db, "A")
				.find((o) => o.observationId === observationId),
		)!;
		const unknown = loss.startsWith("unknown-missing");
		const recordOnly = loss.startsWith("forgotten-record") || receipt;
		const noProvenance = loss.endsWith("without-ref-or-provenance");
		if (unknown) {
			await h.store.write((db) =>
				h.state.deleteObservationInTransaction(db, row),
			);
		} else {
			await h.memory.forget({
				conversationId: "A",
				messageIds: recordOnly ? [] : ["lost-input"],
				itemIds: [],
				...(recordOnly ? { derived: { "memory.records": [row.ref.id] } } : {}),
			});
			if (recordOnly)
				expect(
					h.store.read((db) =>
						h.memory.isBlockedInTransaction(db, "lost-input"),
					),
				).toBe(false);
		}
		if (!unknown || noProvenance) {
			// Simulate the dangling checkpoint left by the previous host, without restoring Memory data.
			await h.store.write((db) => {
				const snapshot = before.snapshot as AgencySnapshot;
				h.state.saveInTransaction(
					db,
					{
						...before,
						snapshot: {
							...snapshot,
							...(noProvenance
								? {
										provenance: {
											version: 1,
											entries: snapshot.provenance!.entries.filter(
												([key]) => key !== `observation:${observationId}`,
											),
										},
									}
								: {}),
							observations: snapshot.observations.map((o) => ({
								...o,
								text: "",
							})),
						},
					},
					h.now(),
				);
				if (
					loss === "forgotten-record" ||
					loss === "forgotten-message-with-record-ref"
				)
					h.state.saveObservationInTransaction(db, row);
			});
		}
		expect(() =>
			h.store.read((db) => h.state.recordsInTransaction(db)),
		).toThrow("agency_archive_unavailable");
		host = h.start(false);
		await host.recover();
		if (unknown) {
			expect(() => host.start()).toThrow("agency_archive_unavailable");
			return;
		}
		expect(() => host.start()).not.toThrow();
		expect(
			host
				.inspect("A")!
				.snapshot.observations.some(
					(o) => o.id === observationId && o.text.length > 0,
				),
		).toBe(false);
		if (receipt)
			expect(
				host
					.inspect("B")!
					.snapshot.observations.find((o) => o.id === observationId)?.text,
			).toBe(independentReceipt!.text);
		expect(
			h.store.read(
				(db) =>
					h.state.recordsInTransaction(db).find((r) => r.conversationId === "B")
						?.scope,
			),
		).toBe(kept.scope);
		expect(
			host
				.inspect("B")!
				.snapshot.observations.find((o) => o.id === "kept-input")?.text,
		).toBe("独立した会話の観測本文");
		h.calls.length = 0;
		await h.exchange("fresh-input", "B", "新しい会話を続けます");
		expect(JSON.stringify(h.calls)).not.toContain("復元してはならない観測本文");
	});
}
