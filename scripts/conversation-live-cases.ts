import type { EumenesClient } from "../client";

/** Isolated test messages only; Memory remains off while raw history is verified. */
export async function conversationLiveCases(client: EumenesClient) {
	await client.setMemoryEnabled(false);
	const results: Record<string, unknown>[] = [];
	const runCase = async (conversationId: string, text: string) => {
		const started = performance.now();
		const submitted = await client.submit({
			requestId: crypto.randomUUID(),
			conversationId,
			text,
		});
		let run = submitted;
		const deadline = Date.now() + 190000;
		while (
			Date.now() < deadline &&
			["queued", "running"].includes(run.status)
		) {
			await Bun.sleep(250);
			run = await client.run(run.id);
		}
		const tasks = await client.agentTasks(run.id);
		const answer = (await client.conversation(conversationId)).messages.find(
			(m) => m.id === run.answerMessageId,
		)?.text;
		const calls = (await client.inferenceUsage()).filter(
			(u) =>
				u.purpose === "llm" &&
				(u.subject === run.id ||
					tasks.some((t) => u.subject.startsWith(`agent:${t.id}:step:`))),
		).length;
		return {
			run,
			tasks,
			answer,
			calls,
			ms: Math.round(performance.now() - started),
		};
	};
	for (let iteration = 1; iteration <= 2; iteration++) {
		const conversationId = `conversation-live-${iteration}`;
		const keyword = "検証用の青い傘";
		const seed = await runCase(
			conversationId,
			`この会話で使う合言葉は「${keyword}」です。メモリには保存せず、了解とだけ答えてください。`,
		);
		const ordinary = {
			case: "ordinary-one-call",
			iteration,
			ok:
				seed.run.status === "completed" &&
				seed.calls === 1 &&
				!seed.tasks.length &&
				!!seed.answer,
			totalModelCalls: seed.calls,
			ms: seed.ms,
		};
		results.push(ordinary);
		console.log(JSON.stringify(ordinary));
		if (!ordinary.ok) break;
		const history = await runCase(
			conversationId,
			"保存済みの会話履歴を検索し、私が決めた合言葉を原文で確認してください。履歴検索だけの要約では決めず、該当発言の前後を履歴読取りで確認し、発言者と根拠を添えて答えてください。Web検索は不要です。",
		);
		const child = history.tasks.find((t) => t.kind === "worker");
		const report = history.run.agentTaskId
			? await client.agentReport(history.run.agentTaskId).catch(() => null)
			: null;
		const ops = child?.toolOutcomes ?? [];
		const memoryOff = !(await client.memoryStatus()).enabled;
		const rawSourceVerified = !!report?.sources.some(
			(s) =>
				"messageId" in s &&
				s.messageId === seed.run.inputMessageId &&
				s.speaker === "user" &&
				!s.url,
		);
		const result = {
			case: "memory-off-history",
			iteration,
			ok:
				history.run.status === "completed" &&
				child?.status === "completed" &&
				memoryOff &&
				rawSourceVerified &&
				!!history.answer?.includes(keyword) &&
				["history.search", "history.read"].every((id) =>
					ops.some(
						(o) =>
							o.state === "succeeded" &&
							o.toolRevisionId.startsWith(`tool:${id}@`),
					),
				) &&
				!ops.some((o) => o.toolRevisionId.startsWith("tool:web.")),
			memoryOff,
			rawSourceVerified,
			childError: child?.errorCode,
			totalModelCalls: history.calls,
			toolOutcomes: ops,
			ms: history.ms,
		};
		results.push(result);
		console.log(JSON.stringify(result));
		if (!result.ok && iteration === 2) break;
	}
	return results;
}
