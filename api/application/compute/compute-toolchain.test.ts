import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { fixture, remote } from "../../domains/compute/test/compute.fixture";
import { TASK_TOOLCHAIN } from "../toolchain/task-delegation.fixture";
import { assignmentFixture } from "../toolchain/assignment.fixture";
import { taskPlan, taskItem } from "../toolchain/task-plan.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("an assignment of the task toolchain selects the registered Python tool, persists the action receipt and reports the result", async () => {
	const f = await fixture();
	let calls = 0;
	const a = await assignmentFixture({
		everyday: true,
		computePort: f.port,
		discoveryTarget: () => "execute_task",
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "python_submit",
				arguments: {
					code: "result = 1 + 1",
					inputs: {},
					timeoutSec: 30,
					accelerator: "cpu",
				},
			}),
		taskStep: (_tools, messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			if (packet.plan.required) return taskPlan("Pythonで1+1を計算する");
			calls++;
			if (calls === 1)
				return { name: "find_toolchain", arguments: { query: "Pythonの計算" } };
			if (calls === 2)
				return {
					name: "compute_python",
					arguments: { stepRef: taskItem(packet), contextRefs: [] },
				};
			expect(packet.results[0].output).toMatchObject({
				state: "completed",
				value: 2,
			});
			return {
				name: "complete_task",
				arguments: {
					summary: "Pythonで計算した結果は2です。",
					fulfilled: ["1+1=2"],
					missing: [],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	const { h } = a;
	try {
		const { result } = await a.assign("1+1をPythonで計算して", TASK_TOOLCHAIN);
		expect(result).toMatchObject({ status: "accepted" });
		await a.settled();
		expect(a.executions()[0]?.status).toBe("completed");
		expect(calls).toBe(3);
		// The finished task's result is what the agent reports.
		expect(a.reported()).toContain("Pythonで計算した結果は2です。");
		expect(h.commandContexts[0]).toContain("python_submit");
		expect(h.commandContexts[0]).not.toContain("fixture-secret");
		const actions = h.store.read((db) =>
			db.query("SELECT tool_revision_id FROM tool_action_invocations").all(),
		);
		expect(actions).toContainEqual({
			tool_revision_id: "tool:python_submit@1",
		});
		const artifacts = await h.request("/api/toolchain-artifacts");
		expect(artifacts.status).toBe(200);
		expect(JSON.stringify(await artifacts.json())).toContain(
			"artifact:compute.workspace@1",
		);

		// A registered UI write goes through the common action ledger, then the same domain.
		f.state.job = remote("running");
		const second = await h.compute!.submit(
			CONVERSATION_DEFAULT_PRINCIPAL,
			"main",
			{ code: "result=4" },
			crypto.randomUUID(),
		);
		await waitFor(
			() =>
				h.compute!.get(CONVERSATION_DEFAULT_PRINCIPAL, second.jobId).state ===
				"running",
		);
		const registration = await (
			await h.request(
				"/api/toolchain-artifacts/artifact%3Acompute.workspace%401",
			)
		).json();
		const source = await (
			await h.request(
				"/api/toolchain-artifacts/artifact%3Acompute.workspace%401/sources/compute",
			)
		).json();
		const now = Date.now();
		const event = {
			version: 1,
			eventId: crypto.randomUUID(),
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60000).toISOString(),
			artifactId: "compute-workspace",
			artifactRevisionId: "artifact:compute.workspace@1",
			scopeRef: registration.scopeRef,
			source: "compute",
			sourceRevision: source.revision,
			actionId: "cancel",
			input: { jobId: second.jobId },
		};
		const response = await h.request("/api/toolchain-actions", event);
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(receipt.status).toBe("accepted");
		expect(
			await (await h.request("/api/toolchain-actions", event)).json(),
		).toEqual(receipt);
		await waitFor(
			() =>
				h.compute!.get(CONVERSATION_DEFAULT_PRINCIPAL, second.jobId).state ===
				"cancelled",
		);
	} finally {
		await a.close();
		await f.close();
	}
}, 20000);

test("recovering an unknown acceptance sends a new completion notice without duplicating either state", async () => {
	const f = await fixture();
	f.state.submitError = new TypeError("fixture disconnect");
	const h = await harness({ computePort: f.port });
	try {
		// A job of the conversation's own origin is announced by the host; an assignment's job is reported by its execution.
		await h.store.write((db) => {
			h.compute!.commandInTransaction(
				db,
				CONVERSATION_DEFAULT_PRINCIPAL,
				"main",
				"conversation",
				"python_submit",
				{ code: "result=2" },
				crypto.randomUUID(),
			);
		});
		await waitFor(
			() =>
				h.compute!.list(CONVERSATION_DEFAULT_PRINCIPAL)[0]?.state ===
				"indeterminate",
		);
		const job = h.compute!.list(CONVERSATION_DEFAULT_PRINCIPAL)[0]!;
		const notices = (state: string) =>
			h.conversation
				.get("main")
				.messages.filter((m) => m.id === `compute-notice:${job.id}:${state}`);
		expect(notices("indeterminate")).toHaveLength(1);
		f.state.submitError = null;
		await h.compute!.reconcile(CONVERSATION_DEFAULT_PRINCIPAL, job.id);
		await waitFor(() => notices("completed").length > 0);
		expect(notices("completed")).toHaveLength(1);
		expect(notices("completed")[0]?.text).toContain("計算結果: 2");
	} finally {
		await h.close();
		await f.close();
	}
}, 20000);
