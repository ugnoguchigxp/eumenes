import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { actionHost } from "./action-host.fixture";
import { weatherFetch } from "../weather/weather.fixture";

for (const kind of ["instant", "pipeline", "task"] as const) {
	test(`Agency uses the registered ${kind} execution contract without a manufactured user run`, async () => {
		const weather = weatherFetch();
		const h = await harness({
			everyday: true,
			resources: true,
			timers: true,
			...(kind === "task"
				? {
						webNote: {
							turn: async () => ({
								text: "題: 確認\n要約: 確認しました\n---\n[根拠](https://example.com)",
								searches: 1,
								usage: null,
							}),
						},
					}
				: {}),
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
						: "web.note",
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
			if (kind !== "task" && kind !== "pipeline")
				expect(h.parentContexts).toHaveLength(0);
		} finally {
			await a.close();
			await h.close();
		}
	}, 15000);
}
