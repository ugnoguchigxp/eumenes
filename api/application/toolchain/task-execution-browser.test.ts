import { expect, test } from "bun:test";
import { createBrowser } from "../../domains/browser";
import {
	fakeBrave,
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
} from "../../domains/browser/test/fakes";
import { registerBrowserEffects } from "../browser/browser-effects";
import { createTaskRunner } from "../browser/browser-task-runner";
import {
	fakeInference,
	finish,
	invoke,
	lastResult,
	observation,
} from "../browser/browser-task.fixture";
import { TASK_TOOLCHAIN } from "./task-delegation.fixture";
import { taskItem, taskPlan } from "./task-plan.fixture";
import { assignmentFixture } from "./assignment.fixture";

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
		title: "Submit a form",
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
	const f = await assignmentFixture({
		everyday: true,
		// This fixture exercises task approval, independently of additions to the recalled catalog.
		discoveryTarget: (query) =>
			query === "browser operations" ? "browser_operate" : "execute_task",
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
	const { h } = f;
	try {
		await h.browser!.service.setting.save(fakeBrave(h.dir));
		await h.browser!.service.connect();
		await f.assign(
			"このページを送信して結果を確認して",
			TASK_TOOLCHAIN,
			undefined,
			"このページを送信し、結果を確認する",
		);
		await f.until(() => f.executions()[0]?.status === "waiting_user");
		work = f.executions()[0]!;
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
		// The approval is the assignment's question; its structured answer goes to the waiting task through its owner's
		// control, as the user's words of a message of the conversation.
		await f.until(() => !!f.items()[0]?.question);
		const words = await f.userWords("続けてよい");
		const owner = h.store.read((db) =>
			h.routing.taskInTransaction!(db, f.card(TASK_TOOLCHAIN).revisionId),
		)!;
		await h.store.write((db) =>
			owner.controlInTransaction(
				db,
				f.conversationId,
				{
					workRef: work.id,
					expectedRevision: work.revision,
					action: "answer",
					input: { approved: true },
					questionRef: work.question!.id,
				},
				words.messageId,
			),
		);
		await f.until(() =>
			["completed", "partial"].includes(f.executions()[0]?.status ?? ""),
		);
		expect(f.executions()[0]).toMatchObject({ status: "completed" });
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
		await f.close();
	}
}, 30000);
