import { partCallJsonSchema } from "eumenes-interact";
import {
	executionCallSession,
	type ChildExecution,
} from "../../domains/tool-runtime";
import type { InteractInference } from "../../domains/browser";
import type { TaskRunnerPorts } from "./browser-task-runner";

/** The Skill speaks invoke/reply; the pure operation core accepts parts. This translates only the wire contract. */
export function interactActionSchema(
	parts = partCallJsonSchema(),
): Record<string, unknown> {
	const props = parts.properties as {
		part: { enum: string[] };
		args: { anyOf: Record<string, unknown>[] };
	};
	const args = structuredClone(props.args.anyOf).map((branch) => {
		const p = branch.properties as Record<string, unknown>;
		if (p.answer) {
			delete p.answer;
			branch.required = (branch.required as string[]).filter(
				(k) => k !== "answer",
			);
		}
		return branch;
	});
	return {
		type: "object",
		properties: {
			action: { type: "string", enum: ["invoke", "reply"] },
			tool: {
				anyOf: [
					{ type: "string", enum: props.part.enum.filter((p) => p !== "ask") },
					{ type: "null" },
				],
			},
			arguments: { anyOf: [...args, { type: "null" }] },
			text: { type: ["string", "null"] },
		},
		required: ["action", "tool", "arguments", "text"],
		additionalProperties: false,
	};
}
export function interactActionToPart(raw: string): string {
	try {
		const a = JSON.parse(raw);
		if (
			a.action === "reply" &&
			a.tool === null &&
			a.arguments === null &&
			typeof a.text === "string" &&
			a.text.trim()
		)
			return JSON.stringify({ part: "ask", args: { question: a.text } });
		if (
			a.action !== "invoke" ||
			typeof a.tool !== "string" ||
			a.tool === "ask" ||
			!a.arguments ||
			typeof a.arguments !== "object" ||
			Array.isArray(a.arguments)
		)
			return raw;
		return JSON.stringify({
			part: a.tool,
			args:
				a.tool === "done" ? { ...a.arguments, answer: a.text } : a.arguments,
		});
	} catch {
		return raw;
	}
}
function actionHistory(raw: string) {
	try {
		const a = JSON.parse(raw);
		if (typeof a.part !== "string" || !a.args) return raw;
		return JSON.stringify(
			a.part === "ask"
				? {
						action: "reply",
						tool: null,
						arguments: null,
						text: a.args.question,
					}
				: {
						action: "invoke",
						tool: a.part,
						arguments:
							a.part === "done"
								? {
										evidence: a.args.evidence,
										outcome: a.args.outcome,
										basis: a.args.basis,
									}
								: a.args,
						text: a.part === "done" ? a.args.answer : null,
					},
		);
	} catch {
		return raw;
	}
}

/** Uses saved settings/catalog and the existing user control receipt, without copying credentials or model names. */
export function createInteractInference(
	ports: Pick<TaskRunnerPorts, "store" | "inference">,
	skill: string,
): InteractInference {
	const { store, inference } = ports;
	return async (input, signal, current) => {
		if (
			!inference.captureUserControlInTransaction ||
			!inference.executeControl ||
			!inference.acceptInTransaction
		)
			throw new Error("control_unavailable");
		const messages = input.prepared.messages.map((m) =>
			input.purpose === "completion_review"
				? m
				: m.role === "system"
					? { ...m, content: skill }
					: m.role === "assistant"
						? { ...m, content: actionHistory(m.content) }
						: m,
		);
		const schema =
			input.purpose === "completion_review"
				? input.prepared.outputSchema
				: interactActionSchema(input.prepared.outputSchema);
		const used = inference.countControlTokens?.(messages) ?? null;
		const window = inference.savedLlmContextWindow?.() ?? null;
		if (used !== null && window !== null && used + 2048 > window)
			throw new Error("context_window_exceeded");
		const id = await store.write((db) => {
			if (!current(db)) throw new Error("browser_interact_not_active");
			return inference.captureUserControlInTransaction!(db, {
				subject: `browser-interact:${input.runId}:${input.step}`,
				deadline: Math.min(input.deadline, Date.now() + 90000),
				maxOutputTokens: 2048,
				route: "subagent",
				structuredOutput: true,
			});
		});
		try {
			const receipt = await inference.executeControl(
				id,
				messages,
				signal,
				undefined,
				{
					...((
						input.source as
							{ kind?: string; execution?: ChildExecution } | undefined
					)?.kind === "execution"
						? executionCallSession(
								(input.source as { execution: ChildExecution }).execution,
							)
						: {}),
					sessionRole: "auxiliary",
					agentSession: {
						conversationId: input.conversationId,
						agentId: input.runId,
					},
					outputSchema: schema,
					cloudOutputSchema: schema,
				},
			);
			const accepted = await store.write(
				(db) =>
					current(db) &&
					!signal.aborted &&
					inference.acceptInTransaction!(db, receipt),
			);
			if (!accepted) throw new Error("permission_revoked");
			if (typeof receipt.value !== "string")
				throw new Error("invalid_inference_result");
			return input.purpose === "completion_review"
				? receipt.value
				: interactActionToPart(receipt.value);
		} catch (e) {
			await store.write((db) =>
				inference.cancelRequestsInTransaction?.(db, [id]),
			);
			throw e;
		}
	};
}
