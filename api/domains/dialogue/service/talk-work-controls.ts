import { systemContext } from "../../../infrastructure/system-context";
import type { AgentToolDefinition } from "../contracts";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import { answerQuestion, handWith } from "./routed-actions";
import { retainedChoice, switchingOf } from "./routed-search";
import type { Turn } from "./routed-turn";

const APPROVE = "approve_confirmation";
const DECLINE = "decline_confirmation";
const DISCARD = "discard_for_pending_switch";
const PREVIEW_CHARS = 240;

const result = (value: unknown, end?: boolean) => ({
	content: typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
	...(end ? { end } : {}),
});

/** Offer only the operations that refer to records from this conversation. The executor checks them again. */
export function createWorkControls(turn: Turn) {
	const routed = turn.routed!;
	const confirmations = new Map(
		routed.pending.confirmations.map((item) => [`c${item.ref}`, item]),
	);
	const revisions = new Map(
		routed.pending.revisions?.map((item) => [`c${item.ref}`, item]),
	);
	const questions = new Map(
		routed.pending.questions.map((item) => [`t${item.ref}`, item.question]),
	);
	const todos = new Map(routed.todos.map((item) => [`t${item.ref}`, item]));
	const switching = switchingOf(turn);
	const tools: AgentToolDefinition[] = [];
	if (confirmations.size || revisions.size) {
		const parameters = {
			type: "object",
			additionalProperties: false,
			required: ["confirmation"],
			properties: {
				confirmation: {
					type: "string",
					enum: [...confirmations.keys()],
					description: JSON.stringify(
						Array.from(confirmations, ([confirmation, item]) => ({
							confirmation,
							toolchain: item.toolchain,
							request: lineText(item.request).slice(0, PREVIEW_CHARS),
							target:
								item.target && lineText(item.target).slice(0, PREVIEW_CHARS),
						})),
					),
				},
			},
		};
		if (confirmations.size)
			tools.push({
				name: APPROVE,
				description: systemContext(
					"dialogue.contexts.local.talk-approve-confirmation",
					{},
				),
				parameters,
			});
		tools.push({
			name: DECLINE,
			description: systemContext(
				"dialogue.contexts.local.talk-decline-confirmation",
				{},
			),
			parameters: {
				...parameters,
				properties: {
					confirmation: {
						...parameters.properties.confirmation,
						enum: [...confirmations.keys(), ...revisions.keys()],
					},
					followUp: { type: "string", enum: ["revise", "cancel"] },
				},
			},
		});
	}
	if (todos.size)
		tools.push({
			name: TOOL_NAMES.work,
			description: systemContext("dialogue.contexts.local.talk-work", {}),
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["todo", "operation"],
				properties: {
					operation: {
						type: "string",
						enum: ["check", "answer", "amend", "cancel"],
					},
					todo: {
						type: "string",
						enum: [...todos.keys()],
						description: JSON.stringify(
							Array.from(todos, ([todo, item]) => ({
								todo,
								title: item.title,
								open: item.open,
								request:
									item.request &&
									lineText(item.request).slice(0, PREVIEW_CHARS),
								question: questions.get(todo),
							})),
						),
					},
				},
			},
		});
	if (switching)
		tools.push({
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
		});

	async function confirmation(name: string, args: Record<string, unknown>) {
		const ref = args.confirmation;
		const item =
			typeof ref === "string"
				? (confirmations.get(ref) ??
					(name === DECLINE ? revisions.get(ref) : undefined))
				: undefined;
		if (
			!item ||
			Object.keys(args).some(
				(k) => k !== "confirmation" && (name !== DECLINE || k !== "followUp"),
			) ||
			(args.followUp !== undefined &&
				args.followUp !== "revise" &&
				args.followUp !== "cancel")
		)
			return result(
				name === DECLINE
					? { declined: false, code: "unknown_confirmation" }
					: { ok: false, code: "unknown_confirmation" },
			);
		if (name === DECLINE)
			return (await turn.decline(item.ref, args.followUp === "revise"))
				? result({
						declined: true,
						...(args.followUp === "revise" ? { revises: ref } : {}),
					})
				: result({ declined: false, code: "confirmation_not_open" });
		const ready = await turn.act(TOOL_NAMES.delegate, {
			mode: "approve",
			confirmation: ref,
			announcement: systemContext("dialogue.contexts.local.approved", {}),
		});
		return "outcome" in ready
			? result(ready.outcome.result, ready.outcome.end)
			: result({ ok: false, code: ready.refused.message });
	}

	async function work(args: Record<string, unknown>) {
		const { todo, operation } = args;
		const item = typeof todo === "string" ? todos.get(todo) : undefined;
		if (
			typeof todo !== "string" ||
			!item ||
			Object.keys(args).length !== 2 ||
			(operation !== "check" && !item.open) ||
			(operation === "answer" && !questions.has(todo))
		)
			return result({ ok: false, code: "work_operation_unavailable" });
		const acted =
			operation === "answer"
				? await answerQuestion(turn, todo, turn.utterance)
				: await turn.act(TOOL_NAMES.work, {
						todo,
						operation,
						...(operation === "amend" ? { text: turn.utterance } : {}),
					});
		return "outcome" in acted
			? result(acted.outcome.result, acted.outcome.end)
			: result({ ok: false, code: acted.refused.message });
	}

	async function discard(args: Record<string, unknown>) {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		if (!switching || !request || Object.keys(args).length !== 1)
			return result({ ok: false, code: "switch_unavailable" });
		const step = await handWith(
			turn,
			retainedChoice(turn, switching.card),
			{
				request,
				words: request,
				resolveUnsaved: "discard",
				...(routed.switchTarget ? { target: routed.switchTarget } : {}),
			},
			systemContext("dialogue.contexts.local.router-announce", {
				title: lineText(switching.title).slice(0, 30),
			}),
			request,
		);
		return step === "done"
			? result({ ok: true }, true)
			: result({
					ok: false,
					code: typeof step === "object" ? step.retry : "switch_unavailable",
				});
	}

	return {
		tools,
		call(name: string, args: Record<string, unknown>) {
			if (name === TOOL_NAMES.work) return work(args);
			if (name === DISCARD) return discard(args);
			return confirmation(name, args);
		},
	};
}
