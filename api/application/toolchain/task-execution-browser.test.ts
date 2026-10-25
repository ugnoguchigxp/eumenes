import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import {
	afterUtterance,
	toolResults,
} from "./conversation-script.fixture";
import { handOverTask } from "./task-delegation.fixture";
import { createBrowser } from "../../domains/browser";
import {
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
	fakeBrave,
} from "../../domains/browser/test/fakes";
import {
	fakeInference,
	observation,
	invoke,
	finish,
	lastResult,
} from "../browser/browser-task.fixture";
import { createTaskRunner } from "../browser/browser-task-runner";
import { registerBrowserEffects } from "../browser/browser-effects";
import { waitFor } from "../../infrastructure/wait-for";

const VIDEO = "https://example.com/watch?v=selected";
const ORIGINAL =
	"Recommend a video and play it in another tab. " +
	"Background note. ".repeat(280) +
	" Keep the volume unchanged. SOURCE_TAIL";

test("one public request searches, passes the exact result URL to a browser child, opens a new tab and confirms playback from the next observation", async () => {
	const driver = new FakeDriver();
	driver.tabs = [
		{ index: 0, url: "https://example.com/", title: "Start", current: true },
	];
	driver.snapshotText = '- button "Play" [ref=e2]';
	const act = driver.act.bind(driver);
	let playing = false;
	driver.act = async (action, signal) => {
		const value = await act(action, signal);
		if (action.kind === "click") {
			playing = true;
			driver.snapshotText = "- status [ref=e3]: Playing selected video";
		}
		return value;
	};
	let published: { revision: number; steps: Array<Record<string, unknown>> };
	const plan = {
		expectedRevision: 0,
		summary: "Open the selected video and verify playback",
		steps: [
			{
				label: "Open and play",
				expectation: "Playing is observed in a new tab",
				state: "running",
			},
		],
	};
	const browserModel = fakeInference([
		invoke("browser.page.script", plan),
		(messages) => {
			published = lastResult(messages).script;
			return invoke("browser.page.tab_new", { url: VIDEO });
		},
		(messages) => {
			const obs = observation(messages);
			expect(driver.tabs.find((t) => t.current)!.url).toBe(VIDEO);
			return invoke("browser.page.click", {
				observationRef: obs.observationRef,
				ref: "e2",
				element: "Play",
				effect: "navigate",
			});
		},
		(messages) => {
			const obs = observation(messages);
			expect(JSON.stringify(obs)).toContain("Playing selected video");
			return invoke("browser.page.script", {
				...plan,
				expectedRevision: published.revision,
				steps: [
					{
						...published.steps[0],
						state: "completed",
						evidenceRef: obs.observationRef,
					},
				],
			});
		},
		finish("Playback was observed in the new tab."),
	]);
	let parentCalls = 0,
		translations = 0;
	const requestedURLs: string[] = [];
	const h = await harness({
		everyday: true,

		discoveryTarget: (query) =>
			query === "operate browser"
				? "browser_operate"
				: query === "find a nature video"
					? "web_search"
					: "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(
				"Find a suitable video and play it in a new tab; preserve the volume.",
				"候補を探して再生を確認します。",
			)(messages),
		acquire: async (req) => {
			const observedAt = new Date().toISOString();
			const text = `Selected video, a short nature film: ${VIDEO}`;
			return {
				freshUntilMs: null,
				result: {
					provider: "llm-fetch@0.1.3",
					observedAt,
					cache: "bypass",
					hits:
						req.operation === "lookup"
							? [
									{
										url: VIDEO,
										title: "Nature film",
										snippet: text,
										provider: "fixture",
										trust: "untrusted",
										tainted: true,
										verification: "search_summary",
									},
								]
							: [],
					documents:
						req.operation === "read"
							? [
									{
										url: VIDEO,
										title: "Nature film",
										text,
										fetchedAt: observedAt,
										truncated: false,
										trust: "untrusted",
										tainted: true,
										verification: "source_read",
										guardDecision: "allow",
										guardReasonCodes: [],
									},
								]
							: [],
					failures: [],
				},
			};
		},
		browser: (store, queue, capabilities) => {
			let service: ReturnType<typeof createBrowser>;
			service = createBrowser({
				store,
				queue,
				driver,
				encoder: new FakeEncoder(),
				files: new FakeFiles(),
				webOrigins: [],
				resolveHost: fakeResolver(),
				canAutoConnect: () => true,
				runTaskStep: createTaskRunner({
					store,
					inference: browserModel.ports,
					capabilities,
					taskExecutionSourceInTransaction: (db, frozen) =>
						service.taskExecutionSourceInTransaction(db, frozen),
				}),
			});
			return {
				service,
				effects: registerBrowserEffects({ queue, service }),
				requests: { userMessageInTransaction: () => null },
			};
		},
		command: (messages) => {
			translations++;
			const packet = JSON.parse(
				messages.filter((m) => m.role === "user").at(-1)!.content,
			);
			expect(JSON.stringify(packet.references)).toContain(VIDEO);
			return JSON.stringify({
				action: "invoke",
				tool: "browser.task.start",
				arguments: {
					request: `Open ${VIDEO} in a new tab and play the selected video. Preserve volume.`,
				},
			});
		},
		taskStep: (tools, messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			if (packet.plan.required)
				return taskPlan(
					"Find a nature video and return its exact watch URL.",
					"Play the selected video from the previous result in a new tab and verify playback.",
				);
			parentCalls++;
			if (parentCalls === 1)
				return {
					name: "find_toolchain",
					arguments: { query: "find a nature video" },
				};
			if (parentCalls === 2)
				return {
					name: "web_search",
					arguments: {
						stepRef: taskItem(packet),
						contextRefs: [],
					},
				};
			if (parentCalls === 3) {
				expect(packet.results[0].summary).toContain(VIDEO);
				return {
					name: "find_toolchain",
					arguments: { query: "operate browser" },
				};
			}
			if (parentCalls === 4)
				return {
					name: "browser_operate",
					arguments: {
						stepRef: taskItem(packet, 1),
						contextRefs: packet.results.flatMap(
							(r: { refs: string[] }) => r.refs,
						),
					},
				};
			expect(playing).toBe(true);
			expect(JSON.stringify(packet.results)).toContain("Playback was observed");
			requestedURLs.push(...driver.tabs.map((t) => t.url));
			return {
				name: "complete_task",
				arguments: {
					summary: "再生を確認しました。",
					fulfilled: ["new tab opened", "playback observed"],
					missing: [],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	try {
		await h.browser!.service.setting.save(fakeBrave(h.dir));
		await h.browser!.service.connect();
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: ORIGINAL,
		});
		await waitFor(() => h.toolchain.agents.executions.list("main").length > 0, {
			timeout: 5000,
		});
		await waitFor(
			() =>
				["completed", "partial", "failed", "interrupted"].includes(
					h.toolchain.agents.executions.list("main")[0]!.status,
				),
			{ timeout: 15000 },
		);
		const work = h.toolchain.agents.executions.list("main")[0]!;

		expect(work).toMatchObject({ status: "completed" });
		expect(h.dialogue.get(source.id)!.status).toBe("completed");
		expect(requestedURLs).toContain(VIDEO);
		expect(driver.tabs).toHaveLength(2);
		expect(driver.calls.filter((c) => c === `newTab:${VIDEO}`)).toHaveLength(1);
		expect(translations).toBe(1);
		expect(parentCalls).toBe(5);
		expect(JSON.stringify(browserModel.state.calls[0])).toContain(
			"SOURCE_TAIL",
		);
		expect(JSON.stringify(browserModel.state.calls[0])).toContain(
			"Keep the volume unchanged",
		);
	} finally {
		await h.close();
	}
}, 25000);

test("a browser approval resumes in a new physical task, keeps the old deadline, and commits the approved operation exactly once", async () => {
	const driver = new FakeDriver();
	driver.tabs = [
		{ index: 0, url: "https://example.com/form", title: "Form", current: true },
	];
	driver.snapshotText = '- button "Submit" [ref=e2]';
	driver.targetInfo = { tag: "button", inForm: true, submits: true };
	let commits = 0,
		published: { revision: number; steps: Array<Record<string, unknown>> };
	const act = driver.act.bind(driver);
	driver.act = async (action, signal) => {
		const value = await act(action, signal);
		if (action.kind === "click") {
			commits++;
			driver.snapshotText = "- status [ref=e3]: Submission confirmed";
		}
		return value;
	};
	const plan = {
		expectedRevision: 0,
		summary: "Submit after approval",
		steps: [
			{
				label: "Submit",
				expectation: "Submission is confirmed",
				state: "running",
			},
		],
	};
	const click = (
		messages: import("../browser/browser-task.fixture").Message[],
	) => {
		const o = observation(messages);
		return invoke("browser.page.click", {
			observationRef: o.observationRef,
			ref: "e2",
			element: "Submit",
			effect: "commit",
		});
	};
	const browserModel = fakeInference([
		invoke("browser.page.script", plan),
		click,
		invoke("browser.page.script", plan),
		(messages) => {
			published = lastResult(messages).script;
			return click(messages);
		},
		(messages) => {
			const o = observation(messages);
			expect(JSON.stringify(o)).toContain("Submission confirmed");
			return invoke("browser.page.script", {
				...plan,
				expectedRevision: published.revision,
				steps: [
					{
						...published.steps[0],
						state: "completed",
						evidenceRef: o.observationRef,
					},
				],
			});
		},
		finish("The approved submission was observed."),
	]);
	let work: import("../../domains/tool-runtime").ExecutionView,
		steps = 0,
		translations = 0;
	const h = await harness({
		everyday: true,
		routeTool: "browser_operate",
		browser: (store, queue, capabilities) => {
			let service: ReturnType<typeof createBrowser>;
			service = createBrowser({
				store,
				queue,
				driver,
				encoder: new FakeEncoder(),
				files: new FakeFiles(),
				webOrigins: [],
				resolveHost: fakeResolver(),
				canAutoConnect: () => true,
				runTaskStep: createTaskRunner({
					store,
					inference: browserModel.ports,
					capabilities,
					taskExecutionSourceInTransaction: (db, frozen) =>
						service.taskExecutionSourceInTransaction(db, frozen),
				}),
			});
			return {
				service,
				effects: registerBrowserEffects({ queue, service }),
				requests: { userMessageInTransaction: () => null },
			};
		},
		firstRound: (_tools, question, messages) => {
			if (question !== "続けてよい")
				return handOverTask(
					"このページを送信し、結果を確認する",
					"操作を確認しながら進めます。",
				)(messages);
			if (toolResults(afterUtterance(messages), "work").length === 0) {
				const todo = h.store
					.read((db) => h.dialogue.todosInTransaction(db, "main"))
					.find((item) => item.status === "waiting")!;
				return {
					calls: [
						{
							name: "work",
							args: {
								todo: todo.id,
								operation: "answer",
								revision: todo.revision,
								questionId: todo.questionId,
								// The approval question asks for a structured answer: its JSON.
								text: JSON.stringify({ approved: true }),
							},
						},
					],
				};
			}
			return { text: "確認を受けて続けます。" };
		},
		command: (messages) => {
			translations++;
			const packet = JSON.parse(messages.at(-1)!.content);
			return JSON.stringify({
				action: "invoke",
				tool: "browser.task.start",
				arguments: {
					request: "Submit the form and verify the outcome",
					...(packet.previousQuestion
						? {
								continueFrom: packet.previousQuestion.result.domain.taskId,
								approvePending: true,
							}
						: {}),
				},
			});
		},
		taskStep: (_tools, messages) => {
			const current = JSON.parse(messages.at(-1)!.content);
			if (current.plan.required)
				return taskPlan("Submit this page and verify the outcome");
			steps++;
			if (steps === 1)
				return {
					name: "find_toolchain",
					arguments: { query: "browser operations" },
				};
			if (steps === 2)
				return {
					name: "browser_operate",
					arguments: {
						stepRef: taskItem(current),
						contextRefs: [],
					},
				};
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(commits).toBe(1);
			return {
				name: "complete_task",
				arguments: {
					summary: "承認された操作の結果を確認しました。",
					fulfilled: ["approved submission confirmed"],
					missing: [],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	try {
		await h.browser!.service.setting.save(fakeBrave(h.dir));
		await h.browser!.service.connect();
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "このページを送信して結果を確認して",
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status ===
				"waiting_user",
			{ timeout: 5000 },
		);
		work = h.toolchain.agents.executions.list("main")[0]!;
		expect(commits).toBe(0);
		expect(work.question!.inputSchema).toMatchObject({
			type: "object",
			required: ["approved"],
		});
		const before = h.store.read((db) =>
			db
				.query("SELECT id,state,deadline FROM browser_tasks ORDER BY rowid")
				.all(),
		) as { id: string; state: string; deadline: number }[];
		expect(before[0]!.state).toBe("needs_input");
		expect(work.question!.expiresAt).toBe(before[0]!.deadline);
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "続けてよい",
		});
		await waitFor(
			() =>
				["completed", "partial"].includes(
					h.toolchain.agents.executions.list("main")[0]?.status ?? "",
				),
			{ timeout: 8000 },
		);
		expect(h.toolchain.agents.executions.list("main")[0]).toMatchObject({
			status: "completed",
		});
		const after = h.store.read((db) =>
			db
				.query("SELECT id,state,deadline FROM browser_tasks ORDER BY rowid")
				.all(),
		) as typeof before;
		expect(after).toHaveLength(2);
		expect(after[1]!.id).not.toBe(after[0]!.id);
		expect(after[1]!.deadline).toBe(before[0]!.deadline);
		expect(commits).toBe(1);
		expect(translations).toBe(2);
		expect(steps).toBe(3);
		expect(
			h.store.read((db) =>
				db.query("SELECT count(*) AS n FROM agent_execution_steps").get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await h.close();
	}
}, 15000);
