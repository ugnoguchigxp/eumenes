import { afterEach, expect, test } from "bun:test";
import { createChildOperations } from "./child-operations";
import {
	setup,
	cleanup,
	finish,
	typeInto,
	observation,
	invoke,
} from "../browser/browser-task-kit";
import { until } from "../../domains/browser/test/fakes";

afterEach(cleanup);
test("an uncollected browser finish does not issue a successful research result", async () => {
	const s = await setup([
		finish("記事へ到着しました。https://example.org/result"),
	]);
	const { connect } = await import("../../domains/browser/test/fakes");
	await connect(s.env);
	const children = createChildOperations(s.service, () => true);
	const started = await s.store.write((db) =>
		children.startInTransaction(db, input()),
	);
	await until(() => children.get(started.operationId)?.state !== "pending");
	expect(
		s.service.taskRow(started.operationId.slice("browser-child:".length))
			?.state,
	).toBe("completed");
	expect(children.get(started.operationId)).toEqual({
		state: "failed",
		errorCode: "browser_collection_missing",
	});
});
test("delegated prose cannot manufacture a quotation that authorizes browser input", async () => {
	const s = await setup([typeInto("秘密の値", "秘密の値")]);
	const { connect } = await import("../../domains/browser/test/fakes");
	await connect(s.env);
	const children = createChildOperations(s.service, () => true);
	const started = await s.store.write((db) =>
		children.startInTransaction(db, {
			...input(),
			request: "秘密の値を入力してください",
		}),
	);
	await until(() => children.get(started.operationId)?.state !== "pending");
	const id = started.operationId.slice("browser-child:".length);
	expect(s.service.taskRow(id)?.request).toBe("指定サイトで探す");
	expect(s.service.taskRow(id)?.state).toBe("needs_input");
	expect(s.driver.calls.some((c) => c === "act:type")).toBe(false);
	expect(s.model.state.calls[0]!.at(-1)!.content).toBe("指定サイトで探す");
});
const input = () => ({
	caller: {
		kind: "research" as const,
		owner: { rootRunId: "root", taskId: "worker", cancelEpoch: 0 },
		invocationId: crypto.randomUUID(),
		source: {
			conversationId: "main",
			messageId: "message",
			runId: "root",
			request: "指定サイトで探す",
			digest: "fixture",
		},
	},
	requestId: crypto.randomUUID(),
	request: "指定サイトで探す",
	deadline: Date.now() + 330000,
	parentJobId: "parent",
});
test("revoked parent cannot adopt a late browser finish or emit a second conversation notice", async () => {
	const s = await setup([finish("late result")]);
	let live = true,
		release!: () => void;
	s.model.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const children = createChildOperations(s.service, () => live);
	// Existing connected task path; no auto connection is needed in this fixture.
	const { connect } = await import("../../domains/browser/test/fakes");
	await connect(s.env);
	const accepted = await s.store.write((db) =>
		children.startInTransaction(db, input()),
	);
	await until(() => s.model.state.calls.length === 1);
	expect(children.get(accepted.operationId)).toMatchObject({
		state: "pending",
		continuing: true,
	});
	live = false;
	release();
	await until(() => children.get(accepted.operationId)?.state !== "pending");
	expect(children.get(accepted.operationId)).toMatchObject({
		state: "cancelled",
	});
	expect(s.notices).toEqual([]);
	expect(
		s.service.researchPages(
			accepted.operationId.slice("browser-child:".length),
		),
	).toEqual([]);
});
test("native work expires while the parent's fallback reserve remains", async () => {
	const s = await setup([]),
		children = createChildOperations(s.service, () => true);
	const started = await s.store.write((db) =>
		children.startInTransaction(db, {
			...input(),
			deadline: Date.now() + 149000,
		}),
	);
	await until(() => children.get(started.operationId)?.state !== "pending");
	expect(children.get(started.operationId)).toMatchObject({
		state: "failed",
		errorCode: "task_expired",
	});
	expect(s.model.state.calls).toHaveLength(0);
});

for (const revoked of [false, true])
	test(`accepted candidates ${revoked ? "are discarded after authority revocation" : "survive native expiry for partial adoption"}`, async () => {
		let now = Date.now(),
			live = true;
		const s = await setup(
			[
				(messages) => {
					const o = observation(messages);
					return invoke("browser.page.collect", {
						observationRef: o.observationRef,
						blockRefs: ["b1"],
						linkBlockRefs: ["b1"],
						purpose: "candidates",
					});
				},
				() => {
					if (revoked) live = false;
					else now += 100000;
					return finish("採取後に終了");
				},
			],
			{ now: () => now },
		);
		s.driver.snapshotText =
			'- link "Observed result" [ref=e1]:\n  - /url: https://example.org/result';
		s.service.setResearchReview(async () => true);
		const { connect } = await import("../../domains/browser/test/fakes");
		await connect(s.env);
		const children = createChildOperations(s.service, () => live);
		const accepted = await s.store.write((db) =>
			children.startInTransaction(db, input()),
		);
		await until(() => children.get(accepted.operationId)?.state !== "pending");
		const result = children.get(accepted.operationId);
		if (revoked) {
			expect(result?.state).toBe("cancelled");
			expect(
				s.service.researchPages(
					accepted.operationId.slice("browser-child:".length),
				),
			).toEqual([]);
		} else {
			expect(result).toMatchObject({
				state: "partial",
				result: { failures: [{ code: "task_expired" }] },
			});
			expect(result?.result?.readings?.[0]?.url).toBe(
				"https://example.org/result",
			);
		}
		expect(s.notices).toEqual([]);
	});
