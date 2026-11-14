import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

const request = "20秒のタイマーの手順を一緒に作ってください";
const condition = "タイマーは20秒に設定する";
const location = {
	evidenceId: "workflow",
	pointer: "/steps/0/task",
};
const finding = {
	title: "タイマーの時間が長い",
	problem: "手順は30秒を指定しています。",
	trigger: "手順を実行した場合",
	impact: "通知が10秒遅れます。",
	severity: "medium",
	confidence: "high",
	primary: location,
	evidence: [location],
	conditionId: "duration",
	minimalFix: "20秒に変更します。",
	verify: "手順の時間指定を確定条件と照合します。",
};
const draft = (seconds: number) => ({
	request,
	steps: [
		{
			id: "timer",
			bundle: "timers.manage",
			task: `${seconds}秒のタイマーを作る`,
			from: ["request"],
			result: "作成済みタイマー",
		},
	],
	output: { from: ["timer"], deliver: "作成したタイマーを伝える" },
});
test("the same Collaboration session reviews two draft versions with grounded findings and confirmed conditions", async () => {
	const requests: {
		version: string;
		seconds: string;
		conditions: unknown[];
	}[] = [];
	const notices: { revision: number; result: unknown }[] = [];
	const diagnostics: string[] = [];
	const packetLine = (content: string, key: string) => {
		const line = content.split("\n").find((line) => line.startsWith(`${key}=`));
		if (!line) {
			diagnostics.push(`missing ${key}: ${content.slice(0, 1800)}`);
			throw new Error(`missing ${key}`);
		}
		return JSON.parse(line.slice(key.length + 1));
	};
	let seconds = 30;
	let operation: "write" | "review" = "write";
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "collaborate_pipeline",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate(
				(card) => card.id === "collaboration.pipeline",
				request,
				{
					announcement: "一緒に手順を作ります。",
					impact: "create",
				},
			)(messages),
		reviewSubagent(messages) {
			expect(messages[0]?.content).toContain("ワークフロー下書きの評価");
			const input = JSON.parse(messages.at(-1)!.content);
			const task = input.evidence.find(
				(entry: { id: string }) => entry.id === "workflow",
			).document.steps[0].task;
			requests.push({
				version: input.target.version,
				seconds: task,
				conditions: input.conditions.entries,
			});
			const correct = task.includes("20秒");
			return {
				findings: correct ? [] : [finding],
				unverified: [],
				scopeChecks: [
					{ evidenceId: "workflow", status: "checked", reason: null },
				],
				conditionChecks: [
					{
						conditionId: "duration",
						status: correct ? "satisfied" : "violated",
						reason: task,
						evidence: [location],
					},
				],
			};
		},
		specialist(messages) {
			const ref = messages[1]!.content;
			const reference = packetLine(ref, "REFERENCE");
			const event = (reference.workContext ?? reference.currentWork)?.hostEvent;
			if (event) {
				expect(event.kind).toBe("review");
				notices.push(event);
				return {
					action: "reply",
					text: `下書きの版${event.revision}を確認しました。`,
				};
			}
			const revision = Number(
				/CURRENT_DOCUMENT path=pipeline\.json revision=(\d+)/.exec(
					messages.map((message) => message.content).join("\n"),
				)?.[1],
			);
			const performed = messages.some((message) =>
				message.content.startsWith("TOOL_RESULT="),
			);
			if (performed)
				return {
					action: "reply",
					text:
						operation === "review"
							? "評価を始めました。"
							: "手順を書きました。",
				};
			if (operation === "review")
				return {
					action: "invoke",
					tool: "collaboration.pipeline.review",
					arguments: { expectedRevision: revision },
					text: "評価を始めました。",
				};
			const { host } = packetLine(ref, "SOURCE_REGISTRY");
			const state = packetLine(ref, "COLLABORATION_STATE");
			return {
				action: "invoke",
				tool: "doc.write",
				arguments: {
					baseRevision: revision,
					title: "タイマーの手順",
					content: draft(seconds),
				},
				text: "手順を書きました。",
				...(seconds === 30
					? {
							stateUpdate: {
								coreContractVersion: 1,
								sessionId: state.sessionId,
								epoch: host.epoch,
								expectedRevision: state.revision,
								sourceRevision: host.sourceRevision,
								work: host.work,
								removals: [],
								upserts: [
									{
										id: "duration",
										kind: "condition",
										status: "confirmed",
										value: condition,
										sourceRefs: [host.sources.at(-1).ref],
										supersedes: [],
									},
								],
							},
						}
					: {}),
			};
		},
	});
	const say = async (text: string) => {
		const res = await h.request("/api/runs", {
			conversationId: "main",
			requestId: crypto.randomUUID(),
			text,
		});
		expect(res.status).toBe(202);
		const run = await res.json();
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 6000 });
		expect(done?.status, JSON.stringify(done) + diagnostics.join("\n")).toBe(
			"completed",
		);
		return h.dialogue.answerText(run.id);
	};
	const waitForNotice = (version: number) =>
		waitFor(
			() =>
				h.conversation
					.get("main")
					.messages.some(
						(message) =>
							message.text === `下書きの版${version}を確認しました。`,
					),
			{ timeout: 6000 },
		);
	const sections = async () => {
		const res = await h.request(
			"/api/toolchain-artifacts/artifact:collaboration.pipeline@1/sources/collaboration?params=" +
				encodeURIComponent(JSON.stringify({ conversationId: "main" })),
		);
		expect(res.status).toBe(200);
		return (await res.json()).data.work.sections;
	};
	try {
		const saved = h.settings.get();
		saved.routes.llm.mode = "larm-preferred";
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: saved.revision,
			settings: saved,
			keys: [],
		});
		expect(await say(request)).toBe("手順を書きました。");
		const session = h.dialogue.specialistSession("main")!;
		const current = () =>
			h.store.read((db) =>
				h.toolchain.collaboration.works.state(db, session.workRef),
			);
		const first = current()!.revision;
		operation = "review";
		expect(await say("今の下書きをレビューして")).toBe("評価を始めました。");
		await waitForNotice(first).catch((error: unknown) => {
			throw new Error(
				JSON.stringify({
					requests,
					notices,
					work: current()?.current,
					diagnostics,
				}),
				{ cause: error },
			);
		});
		expect(notices[0]).toMatchObject({
			revision: first,
			status: "completed",
			result: {
				findings: [finding],
				conditionChecks: [{ conditionId: "duration", status: "violated" }],
			},
		});
		expect(requests[0]).toMatchObject({
			version: String(first),
			seconds: "30秒のタイマーを作る",
			conditions: [
				{
					id: "duration",
					text: condition,
					sources: [
						{
							id: h.conversation
								.get("main")
								.messages.find((m) => m.text === request)!.id,
							version: expect.stringMatching(/^[0-9a-f]{64}$/),
						},
					],
				},
			],
		});
		expect(await sections()).toContainEqual({
			title: "下書きの評価",
			items: ["評価が完了しました。指摘は1件です。"],
		});
		seconds = 20;
		operation = "write";
		expect(await say("指摘どおり20秒に修正して")).toBe("手順を書きました。");
		expect(current()!.current.review).toBeNull();
		expect(await sections()).not.toContainEqual(
			expect.objectContaining({ title: "下書きの評価" }),
		);
		const second = current()!.revision;
		expect(second).toBe(first + 1);
		operation = "review";
		expect(await say("修正した版をもう一度評価して")).toBe(
			"評価を始めました。",
		);
		await waitForNotice(second);
		expect(notices[1]).toMatchObject({
			revision: second,
			status: "completed",
			result: {
				findings: [],
				conditionChecks: [{ conditionId: "duration", status: "satisfied" }],
			},
		});
		expect(h.dialogue.specialistSession("main")?.id).toBe(session.id);
		expect(h.timers!.list().items).toHaveLength(0);
	} finally {
		await h.close();
	}
}, 20_000);
