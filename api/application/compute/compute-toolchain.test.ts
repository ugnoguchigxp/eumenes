import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { fixture, remote } from "../../domains/compute/test/compute.fixture";
import { analysisArgs } from "../../domains/dialogue/test/analysis.fixture";
import { taskPlan, taskItem } from "../toolchain/task-plan.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("conversation selects registered Python tool, persists action receipt and returns result to parent", async () => {
	const f = await fixture();
	let calls = 0;
	const h = await harness({
		everyday: true,
		computePort: f.port,
		routeTool: "compute_python",
		discoveryTarget: () => "compute_python",
		firstRound: () => ({
			name: "execute_task",
			args: {
				...analysisArgs({ kind: "action", impact: "create" }),
				request: "1+1をPythonで計算して",
				contextRefs: [],
				announcement: "計算します。",
			},
		}),
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
		parent: (messages) => {
			const text = JSON.stringify(messages);
			return text.includes("Pythonで計算した結果は2")
				? "Pythonで計算した結果は2です。"
				: "計算を受け付けました。";
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "1+1をPythonで計算して",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		const executions = () =>
			h.store.read((db) =>
				h.toolchain.agents.executions.listInTransaction(db, "main"),
			);
		await waitFor(
			() =>
				["completed", "failed", "partial"].includes(
					executions()[0]?.status ?? "",
				),
			{ timeout: 8000 },
		);
		expect(executions()[0]?.status).toBe("completed");
		expect(calls).toBe(3);
		await waitFor(
			() =>
				h.conversation
					.get("main")
					.messages.some(
						(m) =>
							m.role === "assistant" &&
							m.text === "Pythonで計算した結果は2です。",
					),
			{ timeout: 8000 },
		);
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
		await h.close();
		await f.close();
	}
}, 20000);

test("recovering an unknown acceptance sends a new completion notice without duplicating either state", async () => {
	const f = await fixture();
	f.state.submitError = new TypeError("fixture disconnect");
	const h = await harness({
		computePort: f.port,
		routeTool: "compute_python",
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "python_submit",
				arguments: { code: "result=2" },
			}),
		parent: () => "計算を受け付けました。",
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "Pythonで計算して",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		await waitFor(
			() =>
				h.compute!.list(CONVERSATION_DEFAULT_PRINCIPAL)[0]?.state ===
				"indeterminate",
		);
		const job = h.compute!.list(CONVERSATION_DEFAULT_PRINCIPAL)[0]!;
		expect(
			h.conversation
				.get("main")
				.messages.filter(
					(m) => m.id === `compute-notice:${job.id}:indeterminate`,
				),
		).toHaveLength(1);
		f.state.submitError = null;
		await h.compute!.reconcile(CONVERSATION_DEFAULT_PRINCIPAL, job.id);
		await waitFor(() =>
			h.conversation
				.get("main")
				.messages.some((m) => m.id === `compute-notice:${job.id}:completed`),
		);
		expect(
			h.conversation
				.get("main")
				.messages.filter((m) => m.id === `compute-notice:${job.id}:completed`),
		).toHaveLength(1);
		expect(
			h.conversation
				.get("main")
				.messages.find((m) => m.id === `compute-notice:${job.id}:completed`)
				?.text,
		).toContain("計算結果: 2");
	} finally {
		await h.close();
		await f.close();
	}
}, 20000);
