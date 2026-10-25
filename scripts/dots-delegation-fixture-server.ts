import { harness } from "../api/application/toolchain/toolchain.fixture";
const h = await harness({ dots: true, timers: true });
const { dots, tasks } = h.dotsWork!;
for (const [title, kind] of [
	["完了した調査", "completed"],
	["確認が必要な仕事", "blocked"],
] as const) {
	const r = await tasks.create({
		requestId: crypto.randomUUID(),
		version: 1,
		kind: "orchestration",
		title,
		request: "模擬環境で表示と操作を確認する",
		completionConditions: ["結果と根拠が揃う"],
		startMode: "start",
		grant: {
			connectionRef: "fixture-dots",
			projectRef: "fixture-project",
			operations: ["read", "create_session"],
			maxSessions: 1,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		},
	});
	const ref = dots.commands
		.list("fixture-dots", 0, 100)
		.items.find(
			(i) => dots.getCommand("fixture-dots", i.commandId).taskId === r.taskId,
		)!;
	const c = dots.getCommand("fixture-dots", ref.commandId);
	await dots.claim("fixture-dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	const report = (
		sequence: number,
		state: string,
		extra: Record<string, unknown> = {},
	) => ({
		reportId: crypto.randomUUID(),
		commandId: c.commandId,
		taskId: r.taskId,
		authorityEpoch: c.authorityEpoch,
		executionGeneration: c.executionGeneration,
		sourceSequence: sequence,
		kind: state,
		summary: "模擬調査の要約です。",
		...extra,
	});
	await dots.report(
		"fixture-dots",
		report(1, "session_started", {
			sessions: [
				{
					threadId: crypto.randomUUID(),
					projectId: "fixture-native-project",
					hostId: "local",
					parentThreadId: null,
				},
			],
		}),
	);
	await dots.report(
		"fixture-dots",
		kind === "completed"
			? report(2, "completed", {
					evidenceRefs: ["fixture-evidence"],
					completionChecks: [
						{ status: "satisfied", evidenceRefs: ["fixture-evidence"] },
					],
				})
			: report(2, "blocked", {
					question: {
						questionId: crypto.randomUUID(),
						prompt: "どの対象で進めますか？",
						answerType: "text",
						choices: [],
					},
				}),
	);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: h.app.fetch,
	idleTimeout: 60,
});
console.log(JSON.stringify({ port: server.port }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => {
		void (async () => {
			server.stop(true);
			await h.close();
			process.exit(0);
		})();
	});
