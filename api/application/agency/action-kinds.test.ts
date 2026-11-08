import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { actionHost } from "./action-host.fixture";
import { weatherFetch } from "../weather/weather.fixture";
import { researchScript } from "../../domains/pursuit/test/model.fixture";

for (const kind of ["research", "instant", "pipeline", "task"] as const) {
	test(`Agency uses the registered ${kind} execution contract without a manufactured user run`, async () => {
		const weather = weatherFetch();
		const script = researchScript({ document: true });
		const h = await harness({
			everyday: true,
			resources: true,
			timers: true,
			...(kind === "task" ? { pursuit: (schema) => script(schema) } : {}),
			...(kind === "instant" ? { weather: { fetch: weather.fetch } } : {}),
			...(kind === "pipeline"
				? {
						pipelines: true,
						compose: (messages) => {
							const packet = JSON.parse(messages.at(-1)!.content);
							return {
								status: "ready",
								definition: {
									request: packet.request,
									steps: [
										{
											id: "check",
											bundle: "timers.manage",
											task: "登録済みの予定を確認する",
											from: ["request"],
											result: "確認した予定",
										},
									],
									output: { from: ["check"], deliver: "確認結果" },
								},
							};
						},
					}
				: {}),
			command: () =>
				JSON.stringify({ action: "invoke", tool: "timer.list", arguments: {} }),
		});
		if (kind === "instant") await h.toolchain.weather!.maintain();
		const a = actionHost(h, {
			id:
				kind === "instant"
					? "weather.forecast"
					: kind === "pipeline"
						? "pipeline.execute"
						: kind === "task"
							? "web.research"
							: "web.search",
			question:
				kind === "instant"
					? "散歩する場所の明日の天気を確認する"
					: "関心に関連する情報を確認して整理する",
			...(kind === "instant"
				? {
						arguments: {
							place: "鎌倉",
							prefecture: "神奈川県",
							day: "tomorrow",
						},
					}
				: {}),
		});
		try {
			expect(a.target.requiresApproval).toBe(false);
			await a.start();
			await a.returned();
			const row = a.rows()[0]!;
			const view = h.store.read((db) => a.port.resultsInTransaction(db));
			expect(view).toHaveLength(0);
			const owner = h.store.read((db) =>
				h.routing.taskInTransaction?.(db, a.target.revisionId),
			);
			const actual = owner
				? h.store.read((db) => owner.viewInTransaction(db, row.execution_id))
				: h.toolchain.agents.executions.get(row.execution_id);
			expect(actual).toMatchObject({ status: "completed" });
			expect(
				a.host.inspect("agency-action")!.snapshot.state.intents[0]?.lastReturn
					?.status,
			).toBe("succeeded");
			expect(h.dialogue.list("agency-action")).toHaveLength(0);
			if (kind === "task")
				expect(
					h.dialogue
						.conversationResources("agency-action")
						.resources.some((r) => r.kind === "report"),
				).toBe(true);
			if (kind !== "task" && kind !== "pipeline")
				expect(h.parentContexts).toHaveLength(0);
		} finally {
			await a.close();
			await h.close();
		}
	}, 15000);
}

test("an autonomous owner's question reaches its TODO and resumes only from a real user answer", async () => {
	const script = researchScript({ consult: true, document: true });
	const h = await harness({
		pursuit: (schema) => script(schema),
		firstRound: () => ({ text: "対象期間を受け取りました。" }),
	});
	const a = actionHost(h, {
		id: "web.research",
		question: "関心に関連する情報を確認して整理する",
	});
	try {
		await a.start();
		const { waitFor } = await import("../../infrastructure/wait-for");
		await waitFor(() =>
			h.todos("agency-action").some((t) => t.status === "waiting"),
		);
		const row = a.rows()[0]!;
		const owner = h.store.read((db) =>
			h.routing.taskInTransaction!(db, a.target.revisionId),
		)!;
		const view = h.store.read((db) =>
			owner.viewInTransaction(db, row.execution_id),
		)!;
		expect(view.question).not.toBeNull();
		expect(row.returned).toBe(0);
		const answer = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "agency-action",
			text: "対象期間は今年です。",
		});
		await h.dialogue.waitForTerminal(answer.id, { timeoutMs: 5000 });
		await h.store.write((db) =>
			owner.controlInTransaction(
				db,
				"agency-action",
				{
					workRef: view.id,
					expectedRevision: view.revision,
					action: "answer",
					questionRef: view.question!.id,
					input: { answer: "今年" },
				},
				answer.inputMessageId,
			),
		);
		await a.returned();
		expect(
			h.store.read((db) => owner.viewInTransaction(db, row.execution_id)),
		).toMatchObject({ status: "completed" });
		expect(a.rows()).toHaveLength(1);
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);
