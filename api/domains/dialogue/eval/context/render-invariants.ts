/**
 * The render invariants every format keeps (ContextWindow design section 5.5), checked on an arm's output.
 * An arm that breaks one is rejected at `prepare`, before any model call.
 *
 *  1. The host-designated current request is the input of the assembly, at `currentRequestIndex`, and it is the
 *     last message. (The `current` format may follow it with bare operation results only: the execute phase moves
 *     the request behind them.)
 *  2. Outside the history, no user message is unwrapped: a candidate format wraps every one in its envelope (the
 *     `current` format is allowed its bare result JSON only).
 *  3. The history messages are exactly the ledger turns of the assembly, in order, in their native roles, and
 *     `sessionContext` counts them; no other assistant message exists; the instructions are system messages.
 */
import type { ChatMessage } from "../../service/context";
import type {
	ContextAssembly,
	HistoryTurn,
} from "../../service/context-assembly";
import type { ArmOutput, ContextArm } from "./arm";

const RESULT_KEYS = [
	"actionResult",
	"recognitionResult",
	"delegationResult",
	"drawingResult",
	"imageResult",
	"musicResult",
	"commandQuestion",
];

const sameMessage = (message: ChatMessage, turn: HistoryTurn) =>
	message.role === turn.role &&
	message.content === turn.content &&
	(message.attachments?.length ?? 0) === (turn.attachments?.length ?? 0);

/**
 * Where the history turns sit in `messages`, in order: each turn takes the first later message with its role and
 * text. Null when a turn cannot be found.
 */
export function historyIndexes(
	turns: readonly HistoryTurn[],
	messages: readonly ChatMessage[],
): number[] | null {
	const found: number[] = [];
	let from = 0;
	for (const turn of turns) {
		const index = messages.findIndex(
			(message, i) => i >= from && sameMessage(message, turn),
		);
		if (index < 0) return null;
		found.push(index);
		from = index + 1;
	}
	return found;
}

function isBareResult(content: string): boolean {
	try {
		const value: unknown = JSON.parse(content);
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			(RESULT_KEYS.some((key) => key in value) ||
				("report" in value && "now" in value))
		);
	} catch {
		return false;
	}
}

/** What breaks the invariants in `out`; empty when the output is acceptable. */
export function renderInvariantIssues(
	arm: Pick<ContextArm, "wrapped">,
	assembly: ContextAssembly,
	out: ArmOutput,
): string[] {
	const issues: string[] = [];
	const { messages, sessionContext, currentRequestIndex } = out;
	const request = messages[currentRequestIndex];
	// 1. The designated request.
	if (
		!request ||
		request.role !== "user" ||
		request.content !== assembly.input.content ||
		(request.attachments?.length ?? 0) !==
			(assembly.input.attachments?.length ?? 0)
	)
		issues.push("current_request_not_at_designated_index");
	const history = historyIndexes(assembly.history.turns, messages);
	if (!history) issues.push("history_not_the_ledger_turns");
	const current = arm.wrapped === undefined;
	const trailing = messages.slice(currentRequestIndex + 1);
	if (
		current
			? trailing.some((m) => m.role !== "user" || !isBareResult(m.content))
			: trailing.length > 0
	)
		issues.push("current_request_not_last");
	// 2. No unwrapped user message outside the history.
	const inHistory = new Set(history ?? []);
	for (const [i, message] of messages.entries()) {
		if (inHistory.has(i) || i === currentRequestIndex) continue;
		if (message.role === "assistant")
			issues.push(`assistant_message_outside_history:${i}`);
		else if (message.role === "user") {
			const ok = current
				? isBareResult(message.content)
				: arm.wrapped!(message.content);
			if (!ok) issues.push(`unwrapped_user_message:${i}`);
		}
	}
	// 3. The session split.
	if (sessionContext.historyCount !== assembly.history.turns.length)
		issues.push("history_count_mismatch");
	if (
		sessionContext.instructionCount < 1 ||
		messages
			.slice(0, sessionContext.instructionCount)
			.some((m) => m.role !== "system")
	)
		issues.push("instruction_count_not_system");
	if (
		history &&
		history.length > 0 &&
		history[0]! < sessionContext.instructionCount
	)
		issues.push("history_inside_instructions");
	return issues;
}

/** Throws with every issue when the arm's output for `assembly` breaks an invariant. */
export function assertRenderInvariants(
	arm: ContextArm,
	assembly: ContextAssembly,
	label: string,
): ArmOutput {
	const out = arm.build(assembly);
	const issues = renderInvariantIssues(arm, assembly, out);
	if (issues.length)
		throw new Error(
			`context_eval_render_invariant:${arm.id}:${label}:${issues.join(",")}`,
		);
	return out;
}
