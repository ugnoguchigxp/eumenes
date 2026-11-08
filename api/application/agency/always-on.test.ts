import { expect, test } from "bun:test";
import { alwaysOnFixture, thinkWait } from "./always-on.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";

test("always-on owns one heartbeat, stores canonical bodies in Memory and restores actual speech", async () => {
	const f = await alwaysOnFixture({
		reply: () => ({
			...thinkWait(),
			action: {
				kind: "speak",
				utterance: "fixture own speech",
				toolName: null,
				toolInput: null,
				evidenceRefs: [],
			},
		}),
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(
			() => f.host.inspect("ao")!.snapshot.agent.state.pacing.unanswered === 1,
		);
		expect(f.requests.map((r) => r.purpose)).toEqual(["think"]);
		const saved = f.h.store.read((db) =>
			db
				.query(
					"SELECT snapshot_json FROM dialogue_agency_state WHERE conversation_id='ao'",
				)
				.get(),
		) as { snapshot_json: string };
		expect(saved.snapshot_json).not.toContain("fixture user-a");
		await f.restart();
		expect(f.host.inspect("ao")!.snapshot.agent.state.pacing.unanswered).toBe(
			1,
		);
		expect(
			f.h.conversation.get("ao").messages.filter((m) => m.role === "assistant"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("new user words invalidate the action while an independent think continues", async () => {
	const pending = Promise.withResolvers<ReturnType<typeof thinkWait>>();
	const f = await alwaysOnFixture({ reply: () => pending.promise });
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(() => f.requests.length === 1);
		await f.user("user-b");
		expect(f.signals[0]!.aborted).toBe(false);
		pending.resolve({
			...thinkWait(),
			action: {
				kind: "speak",
				utterance: "stale speech",
				toolName: null,
				toolInput: null,
				evidenceRefs: [],
			},
		});
		await waitFor(
			() =>
				f.host.inspect("ao")!.snapshot.agent.state.thoughts.length === 1 &&
				f.host.status("ao").busy === false,
		);
		expect(
			f.h.conversation
				.get("ao")
				.messages.some((m) => m.text === "stale speech"),
		).toBe(false);
	} finally {
		pending.resolve(thinkWait());
		await f.close();
	}
});

test("a Live handoff is not counted as delivered or replayed after restart", async () => {
	const f = await alwaysOnFixture({
		routeSpeech: () => true,
		reply: () => ({
			...thinkWait(),
			action: {
				kind: "ask",
				utterance: "fixture proposal",
				toolName: null,
				toolInput: null,
				evidenceRefs: [],
			},
		}),
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(() => f.requests.length === 1 && !f.host.status("ao").busy);
		expect(f.host.inspect("ao")!.snapshot.agent.state.pacing.unanswered).toBe(
			0,
		);
		expect(
			f.h.conversation.get("ao").messages.filter((m) => m.role === "assistant"),
		).toHaveLength(0);
		await f.restart();
		expect(f.host.inspect("ao")!.snapshot.tickets).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("preparation uses the registered image owner and returns a real result once", async () => {
	const media = imageFixture("success");
	const f = await alwaysOnFixture({
		media,
		reply: (request, n) => {
			const d = JSON.parse(request.prompt);
			const tool = d.tools[0];
			if (n === 1)
				return {
					...thinkWait(),
					action: {
						kind: "prepare",
						utterance: null,
						toolName: tool.name,
						toolInput: JSON.stringify({
							question: "fixture independent picture",
						}),
						evidenceRefs: ["user-a"],
					},
				};
			const stock = d.stock.find((s: { kind: string }) => s.kind === "finding");
			return stock
				? {
						...thinkWait(),
						action: {
							kind: "speak",
							utterance: "fixture result ready",
							toolName: null,
							toolInput: null,
							evidenceRefs: [stock.id],
						},
					}
				: thinkWait();
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(() =>
			f.host
				.inspect("ao")!
				.snapshot.agent.state.stock.some((s) => s.kind === "finding"),
		);
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(1);
		await f.advance();
		await waitFor(
			() => f.host.inspect("ao")!.snapshot.agent.state.pacing.unanswered === 1,
		);
		expect(JSON.stringify(f.h.dialogue.conversationResources("ao"))).toContain(
			'"image"',
		);
		await f.restart();
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(1);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["user-a"],
			itemIds: [],
		});
		expect(f.host.inspect("ao")!.snapshot.agent.state.stock).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("corrected versions replace old derived state and remain usable after restart", async () => {
	const f = await alwaysOnFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(
			() =>
				f.host.inspect("ao")!.snapshot.agent.state.thoughts.length === 1 &&
				!f.host.status("ao").busy,
		);
		await f.h.conversation.correct({
			messageId: "user-a",
			text: "fixture corrected words",
		});
		await waitFor(() =>
			f.host
				.inspect("ao")!
				.snapshot.agent.observations.some(
					(o) => o.text === "fixture corrected words",
				),
		);
		expect(f.host.inspect("ao")!.snapshot.agent.state.thoughts).toHaveLength(0);
		await f.advance();
		await waitFor(() => f.requests.length === 2 && !f.host.status("ao").busy);
		expect(f.requests[1]!.prompt).toContain("fixture corrected words");
		await f.restart();
		expect(
			f.host
				.inspect("ao")!
				.snapshot.agent.observations.some(
					(o) => o.text === "fixture corrected words",
				),
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("screen typing blocks new ticks and a saved heartbeat preserves its backoff", async () => {
	const f = await alwaysOnFixture();
	try {
		await f.start();
		await f.user("user-a");
		const report = {
			screenId: crypto.randomUUID(),
			revision: 1,
			sentAt: Date.now(),
			typing: true,
			playing: false,
			visible: true,
		};
		await f.host.attend("ao", report);
		await f.advance();
		expect(f.requests).toHaveLength(0);
		await f.host.attend("ao", { ...report, revision: 2, typing: false });
		await f.advance();
		await waitFor(
			() =>
				f.requests.length === 1 &&
				f.host.status("ao").idle?.nextIntervalSec === 20,
		);
		await f.restart();
		expect(f.host.status("ao").idle?.nextIntervalSec).toBe(20);
	} finally {
		await f.close();
	}
});

test("forgetting one conversation leaves another independent think running", async () => {
	const pending = Promise.withResolvers<ReturnType<typeof thinkWait>>();
	const f = await alwaysOnFixture({ reply: () => pending.promise });
	try {
		await f.start();
		await f.user("a-source");
		await f.user("b-source", "b");
		await f.host.attend("b");
		await f.advance();
		await waitFor(() => f.requests.length === 1);
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["a-source"],
			itemIds: [],
		});
		expect(f.signals[0]!.aborted).toBe(false);
		pending.resolve(thinkWait());
		await waitFor(
			() =>
				f.host.inspect("b")!.snapshot.agent.state.thoughts.length === 1 &&
				!f.host.status("b").busy,
		);
		await f.restart();
		expect(
			f.host
				.inspect("b")!
				.snapshot.agent.observations.some((o) => o.id === "b-source"),
		).toBe(true);
	} finally {
		pending.resolve(thinkWait());
		await f.close();
	}
});

test("forgetting a canonical observation Record survives recovery", async () => {
	const f = await alwaysOnFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(
			() =>
				f.host.inspect("ao")!.snapshot.agent.state.thoughts.length === 1 &&
				!f.host.status("ao").busy,
		);
		const row = f.h.store.read((db) =>
			f.port
				.observationsInTransaction(db, "ao")
				.find((r) => r.observationId === "user-a"),
		)!;
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: [],
			itemIds: [],
			derived: { "memory.records": [row.ref.id] },
		});
		await f.restart();
		expect(
			f.host
				.inspect("ao")!
				.snapshot.agent.observations.some((o) => o.id === "user-a"),
		).toBe(false);
		expect(f.host.inspect("ao")!.snapshot.agent.state.thoughts).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("a confirmed normal reply shares preparation through existing State and stock operations", async () => {
	const f = await alwaysOnFixture({
		media: imageFixture("success"),
		reply: (request, n) => {
			const d = JSON.parse(request.prompt);
			if (n === 1)
				return {
					...thinkWait(),
					action: {
						kind: "prepare",
						utterance: null,
						toolName: d.tools[0].name,
						toolInput: JSON.stringify({
							question: "fixture preparation for normal reply",
						}),
						evidenceRefs: ["user-a"],
					},
				};
			const stock = d.stock.find((s: { kind: string }) => s.kind === "finding");
			return stock && request.prompt.includes("fixture normal result shared")
				? {
						...thinkWait(),
						stockOps: [
							{ op: "stock.drop", id: stock.id, text: null, targets: [] },
						],
					}
				: thinkWait();
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		await f.advance();
		await waitFor(() =>
			f.host
				.inspect("ao")!
				.snapshot.agent.state.stock.some((s) => s.kind === "finding"),
		);
		await f.h.store.write((db) => {
			const input = f.host.dialoguePort.inputForContextInTransaction!(db, "ao");
			expect(input.complete).toBe(true);
			expect(
				f.host.dialoguePort.stateForContextInTransaction!(db, "ao").join("\n"),
			).toContain('"finding"');
			f.h.conversation.appendInTransaction(db, {
				id: "normal-answer",
				conversationId: "ao",
				role: "assistant",
				text: "fixture normal result shared",
				runId: null,
				createdAt: new Date().toISOString(),
			});
			f.h.memory!.referenceInputs.recordMessageInTransaction(
				db,
				"normal-answer",
				input,
			);
		});
		await waitFor(() =>
			f.host
				.inspect("ao")!
				.snapshot.agent.observations.some((o) => o.id === "normal-answer"),
		);
		await f.advance();
		await waitFor(() => f.requests.length === 2 && !f.host.status("ao").busy);
		expect(f.host.inspect("ao")!.snapshot.agent.state.stock).toHaveLength(0);
		expect(f.host.inspect("ao")!.snapshot.agent.state.pacing.unanswered).toBe(
			0,
		);
		expect(JSON.stringify(f.h.dialogue.conversationResources("ao"))).toContain(
			'"image"',
		);
		await f.restart();
		expect(f.host.inspect("ao")!.snapshot.agent.state.stock).toHaveLength(0);
	} finally {
		await f.close();
	}
});
