import { expect, test } from "bun:test";
import type { CurationOutput } from "..";
import { addMessage, request } from "./fixture";
import {
	claimOf,
	curate,
	drain,
	mirrorRows,
	nothing,
	pending,
	testPorts,
	TEXT,
	started,
	received,
	withService,
} from "./curation-fixture";
import { openLife } from "./lifecycle-fixture";

// World curation: the feed, pending listings and drain. See curation-fixture.ts for the shared rig.

test("the feed tells the steward which conversations got events, after the receipt committed", async () => {
	const ports = testPorts();
	const { life } = await started(ports);
	try {
		await addMessage(life, "m1", TEXT);
		await received(life);
		expect(ports.received).toEqual([["c1"]]);
		// Nothing new: nobody is told.
		await received(life);
		// A message that is not input: nobody is told.
		await addMessage(life, "a1", "承知しました。", "assistant");
		await received(life);
		expect(ports.received).toEqual([["c1"]]);
		ports.adopted.add("a2");
		await addMessage(life, "a2", "採用された回答です。", "assistant");
		await received(life);
		expect(ports.received).toEqual([["c1"], ["c1"]]);
		// A callback that throws never undoes the receipt.
		const failing = testPorts();
		failing.intake.onEventsReceived = () => {
			throw new Error("kick_failed");
		};
		const next = await openLife({ intake: failing.intake });
		try {
			await next.lifecycle.recoverWorld();
			await addMessage(next, "m1", TEXT);
			expect(await received(next)).toMatchObject({
				received: 1,
				blocked: null,
			});
			expect(mirrorRows(next)).toHaveLength(1);
		} finally {
			await next.cleanup();
		}
	} finally {
		await life.cleanup();
	}
});

test("a pending listing carries message, version, speaker and conversation, oldest first and bounded", async () => {
	const { life, rig } = await started();
	try {
		await addMessage(life, "m1", "一つ目。");
		await addMessage(life, "m2", "二つ目。");
		await addMessage(life, "m3", "三つ目。");
		await received(life);
		const all = pending(rig);
		expect(all.map((e) => [e.messageId, e.speaker, e.conversationId])).toEqual([
			["m1", "user", "c1"],
			["m2", "user", "c1"],
			["m3", "user", "c1"],
		]);
		expect(all[0]!.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(all[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(pending(rig, 2)).toHaveLength(2);
		expect(pending(rig, 0)).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

test("a conversation's pending events are read in the query: a busy neighbour does not crowd them out, an event without a conversation never blocks", async () => {
	const { life, rig } = await started();
	try {
		for (let i = 0; i < 205; i++) await addMessage(life, `a${i}`, `話${i}。`);
		await life.conversation.append({
			id: "b1",
			conversationId: "c2",
			role: "user",
			text: "別の会話。",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		await received(life);
		// 205 events of c1 come first, yet c2's only event is found.
		expect(pending(rig, 12, "c2").map((e) => e.messageId)).toEqual(["b1"]);
		expect(pending(rig, 300, "c1")).toHaveLength(200);
		// Events received before the steward existed carry no conversation: never listed, never in the way.
		await life.store.write((db) =>
			db
				.query(
					"UPDATE world_host_extract_event SET conversation_id = NULL WHERE seq <= 205",
				)
				.run(),
		);
		expect(pending(rig, 12, "c1")).toEqual([]);
		expect(pending(rig, 12).map((e) => e.messageId)).toEqual(["b1"]);
	} finally {
		await life.cleanup();
	}
});

test("a held window is offered again when entities change, also past the first page of 500", async () => {
	const { life, rig } = await started();
	try {
		for (let i = 0; i < 500; i++)
			expect(
				(
					await life.world.apply(
						request(`fill-${i}`, {
							kind: "entity.register",
							entity: {
								id: `a-${String(i).padStart(3, "0")}`,
								displayName: `埋め草${i}`,
								aliases: [],
								externalRefs: [],
							},
						}),
					)
				).status,
			).toBe("applied");
		await withService(life);
		await addMessage(life, "m1", "未登録の何かが9月から使える。");
		await received(life);
		const held = await curate(rig, () => ({
			entities: [],
			claims: [claimOf({ subject: "未登録の何か" })],
		}));
		expect(held.settle).toMatchObject({ status: "held" });
		expect(pending(rig)).toEqual([]);
		// "other-1" sorts after the 500 listed ones: only the digest's tail can see it.
		await life.world.apply(
			request("late", {
				kind: "entity.register",
				entity: {
					id: "other-1",
					displayName: "未登録の何か",
					aliases: [],
					externalRefs: [],
				},
			}),
		);
		expect(pending(rig)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("drain of a whole conversation settles every event once", async () => {
	const { life, rig } = await started();
	try {
		await withService(life);
		for (let i = 1; i <= 3; i++)
			await addMessage(life, `m${i}`, `音声サービスの話${i}。`);
		await received(life);
		const runs = await drain(rig, nothing);
		expect(runs).toHaveLength(1);
		expect(mirrorRows(life).map((r) => r.state)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		const output: CurationOutput = { entities: [], claims: [] };
		expect(output.claims).toEqual([]);
	} finally {
		await life.cleanup();
	}
});

// --- forget operations -------------------------------------------------------

/** Two claims of one entity, each from its own window (so each stands on its own message). */
