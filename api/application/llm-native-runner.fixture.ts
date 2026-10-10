import { harness } from "./toolchain.fixture";
import {
	fixedAcquisition,
	compareRequirementResult,
	type RequirementsCase,
} from "./llm-native-evaluation.fixture";
import type { RequirementProfileData } from "../domains/capabilities";
import type { LarmPort } from "../domains/larm";
import type { Report } from "../domains/agent-runtime";
export async function evaluateRequirements(
	c: RequirementsCase,
	profiles: Map<string, RequirementProfileData>,
	model: LarmPort,
	codexResearch?: {
		model: string;
		execute: (
			messages: import("../domains/inference/contracts").Messages,
			signal: AbortSignal,
		) => Promise<string>;
	},
) {
	const started = performance.now();
	const h = await harness({
		model,
		codexResearch,
		acquire: fixedAcquisition(c.sources),
	});
	try {
		const registered = new Map<string, string>();
		for (const p of c.profiles) {
			const response = await h.app.request(
				`/api/capabilities/requirements/${encodeURIComponent(p.id)}`,
				{
					method: "PUT",
					headers: {
						authorization: "Bearer fixture-token-for-toolchain-browser",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						expectedStateToken: null,
						data: profiles.get(`${c.id}:${p.id}`),
					}),
				},
			);
			if (response.status !== 201)
				throw new Error("evaluation_registration_failed");
			registered.set(p.id, (await response.json()).revisionId);
		}
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "evaluation",
			text: c.request,
		});
		if (response.status !== 202)
			throw new Error("evaluation_submission_failed");
		const run = await response.json();
		const final = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 190000,
		});
		const tasks = h.toolchain.agents.list(run.id);
		const child = tasks.find((t) => t.kind === "worker");
		const selected = child
			? (h.store.read((db) =>
					db
						.query("SELECT input_json FROM agent_tasks WHERE id=?")
						.get(child.id),
				) as { input_json: string })
			: null;
		const engine = selected
			? (JSON.parse(selected.input_json).researcher ?? "default")
			: null;
		let report: Report | null = null;
		try {
			report = h.toolchain.agents.report(final?.agentTaskId ?? run.agentTaskId);
		} catch {}
		const usage = h.inference.usage();
		return {
			caseId: c.id,
			status: final?.status,
			engine,
			structureMatched:
				engine === c.engine && compareRequirementResult(c, report, registered),
			semanticChecks: c.expected.semanticAssertions.map((assertion) => ({
				assertion,
				status: "unchecked",
			})),
			model: usage.map((u) => ({
				purpose: u.purpose,
				source: u.source,
				model: u.model,
				status: u.status,
				elapsedMs: u.ended === null ? null : u.ended - u.started,
			})),
			counts: {
				conversation: Math.min(
					1,
					usage.filter((u) => u.subject === run.id && u.purpose === "llm")
						.length,
				),
				parent: Math.max(
					0,
					usage.filter((u) => u.subject === run.id && u.purpose === "llm")
						.length - 1,
				),
				worker: child?.modelCalls ?? 0,
				verify: child
					? h.store.read((db) =>
							db
								.query(
									"SELECT COUNT(*) AS n FROM agent_steps WHERE task_id=? AND action_kind='verify_requirements'",
								)
								.get(child.id),
						)
					: null,
				tools: child?.toolCalls ?? 0,
			},
			unknownCount:
				report?.version === 3
					? report.requirements.checks.filter((v) => v.status === "unknown")
							.length
					: 0,
			elapsedMs: Math.round(performance.now() - started),
			safeCode: child?.errorCode ?? final?.error ?? null,
			report,
		};
	} finally {
		await h.close();
	}
}
