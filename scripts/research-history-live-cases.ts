import { researchLiveMetrics } from "./research-live-metrics";
import type { EumenesClient } from "../client";
const cases = [
	{
		name: "long-public-document",
		question:
			"https://system.data.sqlite.org/home/doc/8e13c43294410407/Doc/Extra/Core/lang_select.html のSQLite公式資料から、LIMITが負数の場合とOFFSETが負数の場合の扱いを確認してください。本文約3万文字付近の説明が必要です。先頭と末尾のプレビューだけで決めず、web.findでnegative valueを探してweb.read_savedで該当範囲を読み、原文の根拠付きで報告してください。",
		requiresLocal: true,
	},
	{
		name: "first-candidate-mismatch",
		question:
			"SQLiteのSELECTにLIMITが負数のときの動作を調べてください。まず https://system.data.sqlite.org/home/doc/8e13c43294410407/Doc/Extra/Core/lang_createview.html を読み、資料が目的に合わなければ https://system.data.sqlite.org/home/doc/8e13c43294410407/Doc/Extra/Core/lang_select.html を読んで確認してください。対象外の情報を答えに混ぜないでください。",
		requiresReads: 2,
	},
	{
		name: "changed-search-query",
		question:
			"SQLiteでLIMITが負数の場合の行数上限を公式資料で確認してください。最初は『site:system.data.sqlite.org lang_createview negative LIMIT』でCREATE VIEW資料に説明があるか検索してください。SELECTの説明が不足していれば『site:system.data.sqlite.org lang_select negative value no upper bound』へ検索語を変えて再検索してください。検索語を変えた後にSystem.Data.SQLiteが配布する公式資料の本文を読み、必要な範囲をweb.findとweb.read_savedで確認して、根拠付きで答えてください。",
		requiresLookups: 2,
		requiresReads: 1,
	},
];
/** Real LARM + public Web; only isolated test conversation facts reach this evidence file. */
export async function researchHistoryLiveCases(client: EumenesClient) {
	const results: Record<string, unknown>[] = [];
	for (const item of cases.filter(
		(c) =>
			!process.env.EUMENES_LIVE_CASE ||
			c.name === process.env.EUMENES_LIVE_CASE,
	)) {
		for (let iteration = 1; iteration <= 2; iteration++) {
			const started = performance.now();
			const run = await client.submit({
				requestId: crypto.randomUUID(),
				conversationId: `research-history-live-${item.name}-${iteration}`,
				text: item.question,
			});
			let current = run;
			const deadline = Date.now() + 190000;
			while (
				Date.now() < deadline &&
				["queued", "running"].includes(current.status)
			) {
				await Bun.sleep(250);
				current = await client.run(run.id);
			}
			const tasks = await client.agentTasks(run.id),
				child = tasks.find((t) => t.kind === "worker");
			const report = current.agentTaskId
				? await client.agentReport(current.agentTaskId!).catch(() => null)
				: null;
			const ops = child?.toolOutcomes ?? [];
			const local = ops.filter((o) =>
				/tool:web\.(find|read_saved)@/.test(o.toolRevisionId),
			).length;
			const lookups = ops.filter((o) =>
				o.toolRevisionId.startsWith("tool:web.lookup@"),
			).length;
			const reads = ops.filter((o) =>
				/tool:web\.(read|forecast|quote)@/.test(o.toolRevisionId),
			).length;
			const external = ops.length - local;
			const answer = (
				await client.conversation(
					`research-history-live-${item.name}-${iteration}`,
				)
			).messages.find((m) => m.id === current.answerMessageId)?.text;
			const evidence = (report?.claims ?? [])
				.flatMap((c) => c.evidence.map((e) => e.quote))
				.join(" ")
				.replace(/\s+/g, " ");
			const target =
				/negative (value|integer)/i.test(evidence) &&
				/no upper bound/i.test(evidence) &&
				(item.name !== "long-public-document" ||
					/same as (?:if it had evaluated to )?zero/i.test(evidence));
			const succeeded = ops.filter((o) => o.state === "succeeded");
			const sequence =
				(!item.requiresLocal ||
					["web.find", "web.read_saved"].every((id) =>
						succeeded.some((o) => o.toolRevisionId.startsWith(`tool:${id}@`)),
					)) &&
				(!item.requiresReads ||
					succeeded.filter((o) => o.toolRevisionId.startsWith("tool:web.read@"))
						.length >= item.requiresReads) &&
				(!item.requiresLookups ||
					succeeded.filter((o) =>
						o.toolRevisionId.startsWith("tool:web.lookup@"),
					).length >= item.requiresLookups);
			const result = {
				case: item.name,
				iteration,
				ok:
					current.status === "completed" &&
					child?.status === "completed" &&
					!!answer &&
					target &&
					sequence,
				outcome: report && "outcome" in report ? report.outcome : undefined,
				status: current.status,
				childError: child?.errorCode,
				rootError: tasks.find((t) => t.kind === "coordinator")?.errorCode,
				targetReached: target,
				scenarioExercised: sequence,
				externalCalls: external,
				lookupCalls: lookups,
				fetchCalls: reads,
				localCalls: local,
				modelCalls: child?.modelCalls,
				...researchLiveMetrics(await client.inferenceUsage(), run.id, tasks),
				toolOutcomes: ops,
				sourceCount: report?.sources.length,
				viewCount: report?.sources.filter((s) => "viewId" in s && s.viewId)
					.length,
				coverage: report?.coverage,
				limitations: report?.limitations,
				ms: Math.round(performance.now() - started),
			};
			results.push(result);
			console.log(JSON.stringify(result));
			if (!result.ok && iteration === 2) return results;
		}
	}
	return results;
}
