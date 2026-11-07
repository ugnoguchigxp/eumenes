import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { actionHost } from "./action-host.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";

test("forgetting after capability discovery leaves readable checkpoints on restart", async () => {
	const h = await harness({
		everyday: true,
		timers: true,
		memory: true,
		discoveryTarget: () => "timer",
	});
	const a = actionHost(
		h,
		{ id: "timers.manage", question: "登録済みの予定を確認する" },
		{ discover: true },
	);
	try {
		await a.start();
		await waitFor(
			() =>
				a.host
					.inspect("agency-action")
					?.snapshot.observations.some((o) => o.kind === "action.observed") ??
				false,
		);
		await settle();
		expect(
			await h.memory!.forget({
				conversationId: "agency-action",
				messageIds: ["interest-user"],
				itemIds: [],
			}),
		).toMatchObject({ completed: true });
		expect(() =>
			h.store.read((db) => a.port.recordsInTransaction(db)),
		).not.toThrow();
		await a.restart();
		expect(
			a.host
				.inspect("agency-action")
				?.snapshot.observations.some((o) => o.text.includes("雲を眺め")),
		).toBe(false);
		expect(a.rows()).toHaveLength(0);
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);

test("forgetting an archived Memory Record also invalidates its Agency checkpoint", async () => {
	const h = await harness({
		everyday: true,
		timers: true,
		memory: true,
		discoveryTarget: () => "timer",
	});
	const a = actionHost(
		h,
		{ id: "timers.manage", question: "登録済みの予定を確認する" },
		{ discover: true },
	);
	try {
		await a.start();
		await waitFor(
			() =>
				a.host
					.inspect("agency-action")
					?.snapshot.observations.some((o) => o.kind === "action.observed") ??
				false,
		);
		await settle();
		const row = h.store.read((db) =>
			a.port
				.observationsInTransaction(db, "agency-action")
				.find((o) => o.observationId === "interest-user"),
		)!;
		expect(
			await h.memory!.forget({
				conversationId: "agency-action",
				messageIds: [],
				itemIds: [],
				derived: { "memory.records": [row.ref.id] },
			}),
		).toMatchObject({ completed: true });
		expect(() =>
			h.store.read((db) => a.port.recordsInTransaction(db)),
		).not.toThrow();
		await a.restart();
		expect(
			a.host
				.inspect("agency-action")
				?.snapshot.observations.some((o) => o.text.includes("雲を眺め")),
		).toBe(false);
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);
