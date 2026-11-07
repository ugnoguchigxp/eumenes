import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { imageFixture } from "../media/image.fixture";
import { musicFixture } from "../media/music.fixture";
import { autonomousActionSource } from "../../domains/dialogue";
import { actionHost } from "./action-host.fixture";
import { waitFor } from "../../infrastructure/wait-for";

for (const type of ["image", "music"] as const) {
	test(`Agency delegates ${type} creation through shared execution and returns a resource without a user request`, async () => {
		const media = type === "image" ? imageFixture("success") : musicFixture();
		const h = await harness({
			everyday: true,
			resources: true,
			memory: true,
			model: media.model,
			...(type === "image"
				? { imageGateway: media.gateway }
				: { musicGateway: media.gateway }),
		});
		const a = actionHost(h, {
			id: `${type}.create`,
			question:
				type === "image"
					? "雲を眺める散歩の静かな雰囲気を一枚の絵にする"
					: "散歩の落ち着いた気分に合う短い器楽曲を作る",
		});
		try {
			expect(a.target.requiresApproval).toBe(false);
			await a.start();
			await a.returned();
			const view = h.toolchain.agents.executions.list("agency-action")[0]!;
			expect(view.status).toBe("completed");
			expect(view.result?.links?.length).toBeGreaterThan(0);
			expect(h.parentContexts).toHaveLength(0);
			const row = a.rows()[0]!;
			expect(
				h.store.read((db) =>
					autonomousActionSource(db, row.root_id, Date.now()),
				),
			).toMatchObject({ origin: "autonomous", messageId: null });
			expect(h.dialogue.list("agency-action")).toHaveLength(0);
			expect(
				JSON.stringify(h.dialogue.conversationResources("agency-action")),
			).toContain(type === "image" ? '"image"' : '"music.track"');
			expect(
				a.host.inspect("agency-action")!.snapshot.state.intents[0]?.lastReturn
					?.status,
			).toBe("succeeded");
			await a.restart();
			expect(h.toolchain.agents.executions.list("agency-action")).toHaveLength(
				1,
			);
			const source = h.store.read((db) =>
				autonomousActionSource(db, row.root_id, Date.now()),
			)!;
			expect(
				h.store.read((db) =>
					h.executionPort!.validSourceInTransaction(db, {
						...source,
						request: "別の依頼",
					}),
				),
			).toBe(false);
			expect(
				(
					await h.memory!.forget({
						conversationId: "agency-action",
						messageIds: ["interest-user"],
						itemIds: [],
					})
				).completed,
			).toBe(true);
			expect(
				h.store.read((db) =>
					autonomousActionSource(db, row.root_id, Date.now()),
				),
			).toBeNull();
			expect(a.rows()[0]!.authority_json).toBeNull();
			expect(h.toolchain.agents.executions.list("agency-action")).toEqual([]);
			expect(
				h.dialogue.conversationResources("agency-action").resources,
			).toHaveLength(0);
			const copies = h.store.read((db) =>
				db
					.query(
						"SELECT request,title,result_json FROM dialogue_work WHERE source_ref=?",
					)
					.get(row.execution_id),
			);
			expect(copies).toEqual({ request: "", title: "", result_json: null });
		} finally {
			await a.close();
			await h.close();
		}
	}, 15000);
}

test("catalog result drives a further action after restart even when the speech cap is reached", async () => {
	const h = await harness({
		everyday: true,
		timers: true,
		discoveryTarget: () => "timer",
		command: () =>
			JSON.stringify({ action: "invoke", tool: "timer.list", arguments: {} }),
	});
	const a = actionHost(
		h,
		{ id: "timers.manage", question: "登録済みの予定を確認する" },
		{ speakFirst: true, discover: true },
	);
	try {
		await a.start();
		await waitFor(() => a.host.inspect("agency-action")?.idle.unanswered === 1);
		a.inference.busy = true;
		await a.advance(61000);
		expect(a.stats.timerCallbacks).toBeLessThan(5);
		expect(a.requests.filter((r) => r.purpose === "select")).toHaveLength(1);
		a.inference.busy = false;
		await a.advance(61000);
		await waitFor(() =>
			a.host
				.inspect("agency-action")!
				.snapshot.observations.some(
					(o) => o.kind === "action.observed" && o.text?.includes("revisionId"),
				),
		).catch((error) => {
			console.error(
				JSON.stringify({
					snapshot: a.host.inspect("agency-action"),
					requests: a.requests,
				}),
			);
			throw error;
		});
		expect(a.rows()).toHaveLength(0);
		await a.restart();
		await a.advance(61000);
		await a.returned();
		expect(a.rows()).toHaveLength(1);
		expect(
			h.toolchain.agents.executions.list("agency-action")[0],
		).toMatchObject({ status: "completed" });
		expect(a.host.inspect("agency-action")?.idle.unanswered).toBe(1);
		expect(
			h.conversation
				.get("agency-action")
				.messages.filter((m) => m.role === "assistant" && !m.runId),
		).toHaveLength(1);
		expect(h.commandContexts).toHaveLength(1);
		const context = h.commandContexts[0]!;
		expect(context).not.toContain('"name":"timer.start"');
		expect(h.parentContexts).toHaveLength(0);
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);
