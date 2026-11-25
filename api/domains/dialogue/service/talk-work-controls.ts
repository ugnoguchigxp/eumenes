import { systemContext } from "../../../infrastructure/system-context";
import type { AgentToolDefinition } from "../contracts";
import { handWith } from "./routed-actions";
import { retainedChoice, switchingOf } from "./routed-search";
import type { Turn } from "./routed-turn";

const DISCARD = "discard_for_pending_switch";

export const WORK_CONTROL_TOOLS: readonly AgentToolDefinition[] = [
	{
		name: DISCARD,
		description: systemContext(
			"dialogue.contexts.local.talk-discard-switch",
			{},
		),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["request"],
			properties: { request: { type: "string" } },
		},
	},
];

const result = (value: unknown, end?: boolean) => ({
	content: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
	...(end ? { end } : {}),
});

/** Keep work-control tool schemas static for KV cache reuse; every call is validated against this turn's records. */
export function createWorkControls(turn: Turn) {
	const routed = turn.routed!;
	const switching = switchingOf(turn);
	const tools: readonly AgentToolDefinition[] = WORK_CONTROL_TOOLS;

	async function discard(args: Record<string, unknown>) {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		if (!switching || !request || Object.keys(args).length !== 1)
			return result({ ok: false, code: "switch_unavailable" });
		const step = await handWith(
			turn,
			retainedChoice(turn, switching.card),
			{
				request,
				resolveUnsaved: "discard",
				...(routed.switchTarget ? { target: routed.switchTarget } : {}),
			},
			request,
		);
		return step === "done"
			? result({ ok: true }, true)
			: result({
					ok: false,
					code:
						typeof step === "object" && "retry" in step
							? step.retry
							: "switch_unavailable",
				});
	}

	return { tools, call: discard };
}
