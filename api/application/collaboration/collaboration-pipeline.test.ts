import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

test("a collaborative draft is edited, confirmed and executed exactly once without recomposing, then reported to the same session", async () => {
	const request = "二つのタイマーの手順を一緒に作って。最初は20秒、次は30秒";
	const definition = {
		request,
		steps: [
			{
				id: "first",
				bundle: "timers.manage",
				task: "20秒のタイマー",
				from: ["request"],
				result: "保存済みタイマー",
			},
			{
				id: "second",
				bundle: "timers.manage",
				task: "30秒のタイマー",
				from: ["first"],
				result: "保存済みタイマー",
			},
		],
		output: { from: ["second"], deliver: "作成したタイマーを報告" },
	};
	let stage = 0,
		compose = 0;
	const observations: string[] = [];
	const traces: string[] = [];
	const h = await harness({
		memory: true,
		pipelines: true,
		timers: true,
		discoveryTarget: () => "collaborate_pipeline",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate((c) => c.id === "collaboration.pipeline", request, {
				announcement: "一緒に手順を作ります。",
				impact: "create",
			})(messages),
		compose: () => {
			compose++;
			throw new Error("confirmed_draft_must_not_be_recomposed");
		},
		specialist: (messages) => {
			const prompt = messages.map((m) => m.content).join("\n");
			const lines = messages[1]!.content.split("\n");
			const savedLine = lines.find((line) =>
				line.startsWith("COLLABORATION_STATE="),
			);
			const saved = savedLine
				? JSON.parse(savedLine.slice("COLLABORATION_STATE=".length))
				: null;
			const registryLine = lines.find((line) =>
				line.startsWith("SOURCE_REGISTRY="),
			);
			const registry = registryLine
				? JSON.parse(registryLine.slice("SOURCE_REGISTRY=".length))
				: null;
			const host = registry?.host;
			const sourceRef = host?.sources
				.filter((s: { active: boolean }) => s.active)
				.at(-1)?.ref;
			const stateUpdate = saved && {
				coreContractVersion: 1,
				sessionId: saved.sessionId,
				epoch: host.epoch,
				expectedRevision: saved.revision,
				sourceRevision: host.sourceRevision,
				work: host.work,
				removals: [],
				upserts:
					stage === 0
						? [
								{
									id: "first-duration",
									kind: "condition",
									status: "confirmed",
									value: 20,
									sourceRefs: [sourceRef],
									supersedes: [],
								},
								{
									id: "second-duration",
									kind: "condition",
									status: "confirmed",
									value: 30,
									sourceRefs: [sourceRef],
									supersedes: [],
								},
							]
						: [
								{
									id: "corrected-duration",
									kind: "condition",
									status: "confirmed",
									value: 45,
									sourceRefs: [sourceRef],
									supersedes: ["second-duration"],
								},
							],
			};
			traces.push(prompt);
			const revision = Number(
				/CURRENT_DOCUMENT path=pipeline\.json revision=(\d+)/.exec(prompt)?.[1],
			);
			if (stage === 0) {
				stage++;
				return {
					stateUpdate,
					action: "invoke",
					tool: "doc.write",
					arguments: {
						baseRevision: revision,
						title: "タイマーの手順",
						content: definition,
					},
					text: "手順を作りました。",
				};
			}
			if (stage === 1) {
				stage++;
				return {
					stateUpdate,
					action: "invoke",
					tool: "doc.edit",
					arguments: {
						baseRevision: revision,
						edits: [
							{
								old: '"task": "30秒のタイマー"',
								new: '"task": "45秒のタイマー"',
							},
						],
					},
					text: "二つ目を45秒に変えました。",
				};
			}
			if (stage === 2) {
				stage++;
				return {
					action: "invoke",
					tool: "collaboration.pipeline.start",
					arguments: { expectedRevision: revision },
					text: "確認した手順で進めます。",
				};
			}
			observations.push(prompt);
			const schema = JSON.parse(
				messages[0]!.content.split("\nOUTPUT_SCHEMA=")[1]!,
			);
			expect(schema.properties.action.enum).toEqual(["reply"]);
			return { action: "reply", text: "二つのタイマーを作成しました。" };
		},
		command: (messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.originalRequest).toBe(request);
			return JSON.stringify({
				action: "invoke",
				tool: "timer.start",
				arguments: {
					durationSeconds: packet.request.includes("45秒") ? 45 : 20,
					label: packet.request.includes("45秒") ? "second" : "first",
				},
			});
		},
	});
	const say = async (text: string) => {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		expect(response.status).toBe(202);
		const run = await response.json();
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 6000 });
		expect(
			done?.status,
			JSON.stringify(done) + traces.at(-1)?.slice(-6500),
		).toBe("completed");
		return run.id;
	};
	const session = async () =>
		(await (await h.request("/api/conversations/main/specialist")).json())
			.session;
	const source = async (conversationId = "main") =>
		h.request(
			"/api/toolchain-artifacts/artifact:collaboration.pipeline@1/sources/collaboration?params=" +
				encodeURIComponent(JSON.stringify({ conversationId })),
		);
	try {
		const saved = h.settings.get();
		saved.routes.llm.mode = "larm-preferred";
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: saved.revision,
			settings: saved,
			keys: [],
		});
		expect(
			h.store
				.read((db) => h.routing.catalogInTransaction(db))
				.find((c) => c.id === "collaboration.pipeline")?.runtime.binding
				?.available,
		).toBe(true);
		const initial = await say(request);
		expect(h.dialogue.answerText(initial)).toBe("手順を作りました。");
		const owner = await session();
		expect(owner).toBeTruthy();
		expect(h.toolchain.agents.executions.list("main")).toHaveLength(0);
		await say("二つ目だけ45秒に直して");
		const draft = await (await source()).json();
		expect(draft.data.work.summary).toContain("45秒のタイマー");
		expect(draft.data.work.summary).toContain("20秒のタイマー");
		expect(draft.data.work.request).toBe(request);
		const conditionResponse = await h.request(
			`/api/specialist-sessions/${owner.id}/collaboration-state`,
		);
		expect(conditionResponse.status).toBe(200);
		const { state: conditions } = await conditionResponse.json();
		expect(conditions.facts.map((f: any) => [f.id, f.status, f.value])).toEqual(
			[
				["first-duration", "confirmed", 20],
				["second-duration", "retracted", 30],
				["corrected-duration", "confirmed", 45],
			],
		);
		expect(conditions.facts[0].sourceRefs).not.toEqual(
			conditions.facts[2].sourceRefs,
		);
		expect(h.toolchain.agents.executions.list("main")).toHaveLength(0);
		await say("この内容で実行してください");
		await waitFor(
			() =>
				["completed", "partial", "failed", "cancelled"].includes(
					h.toolchain.agents.executions.list("main")[0]?.status ?? "",
				),
			{ timeout: 6000 },
		);
		expect(
			h.toolchain.agents.executions.list("main")[0]?.status,
			JSON.stringify(h.toolchain.agents.executions.list("main")[0]),
		).toBe("completed");
		await waitFor(
			async () =>
				(await session())?.activeRunId === null && observations.length === 1,
			{ timeout: 6000 },
		);
		expect((await session()).id).toBe(owner.id);
		expect(compose).toBe(0);
		const commandSnapshots = h.store.read((db) =>
			db
				.query<{ snapshot: string }, []>(
					"SELECT snapshot FROM inference_requests WHERE subject LIKE 'execution-command:%' ORDER BY subject",
				)
				.all(),
		);
		expect(commandSnapshots).toHaveLength(2);
		expect(
			commandSnapshots.map((row) => JSON.parse(row.snapshot).routes.llm.mode),
		).toEqual(["larm-preferred", "larm-preferred"]);
		expect(h.toolchain.agents.executions.list("main")).toHaveLength(1);
		const timers = await (await h.request("/api/timers")).json();
		expect(
			timers.items
				.map((t: any) => t.durationSeconds)
				.sort((a: number, b: number) => a - b),
		).toEqual([20, 45]);
		expect(
			h.store
				.read((db) => h.conversation.messagesInTransaction(db, "main"))
				.filter((m) => m.role === "user"),
		).toHaveLength(3);
		expect((await (await source()).json()).data.work.summary).toBe(
			"二つのタイマーを作成しました。",
		);
		expect((await source("another-conversation")).status).toBe(404);
	} finally {
		await h.close();
	}
});
