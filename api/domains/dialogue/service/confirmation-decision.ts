import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { AgentToolCall } from "../contracts";
import type { ChatMessage } from "./context";
import type { Turn } from "./routed-turn";

const oneOf = (values: string[]) => ({ type: "string", enum: values });
/** A later call after a tool result already has a decision to follow. Only the first foreground reply is eligible. */
export function firstConfirmationReply() {
	let first = true;
	return (tools: readonly { name: string }[]) => {
		const pending =
			first && tools.some((t) => t.name === "decline_confirmation");
		first = false;
		return pending;
	};
}

/** Which open confirmation was actually the last thing said, even after the recent window was cut. */
function lastPresentedRef(turn: Turn) {
	const { deps, input } = turn;
	return deps.store.read((db) => {
		const events = deps.continuity.events;
		const last = events.latestReplySeqInTransaction(db, input.conversationId);
		if (!last) return null;
		for (const item of turn.routed?.pending.confirmations ?? []) {
			const row = deps.work?.confirmationByRefInTransaction(
				db,
				input.conversationId,
				item.ref,
			);
			const statement =
				row && deps.work?.confirmationStatementInTransaction(db, row);
			if (statement?.seq !== last) continue;
			const heard = events.heardInTransaction(
				db,
				input.conversationId,
				statement.id,
			);
			if (
				heard === "full" ||
				(heard === "partial" && row?.impact !== "irreversible")
			)
				return `c${item.ref}`;
		}
		return null;
	});
}

/** A single structured decision when the first reply to a presented confirmation only produced words. */
async function confirmationDecision(
	turn: Turn,
	messages: ChatMessage[],
): Promise<AgentToolCall | null> {
	const pending = turn.routed?.pending;
	if (!pending) return null;
	const open = pending.confirmations.map((c) => `c${c.ref}`);
	const refs = [...open, ...(pending.revisions ?? []).map((c) => `c${c.ref}`)];
	if (!refs.length) return null;
	const candidates = (turn.input.offers ?? []).map((o) => o.card.id);
	const actions = ["reply", "cancel", "clarify"];
	if (open.length) actions.push("approve");
	if (candidates.length) actions.push("revise");
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["choice", "confirmation", "toolchain", "request"],
		properties: {
			choice: oneOf(actions),
			confirmation: oneOf(["", ...refs]),
			toolchain: oneOf(["", ...candidates]),
			request: {
				type: "string",
				description:
					"revise のときだけ訂正版の作業指示の全文を書く。他の操作では空文字。",
			},
		},
	};
	const context = systemContext(
		"dialogue.contexts.local.confirmation-decision",
		{},
	);
	const decision = await turn.choose(
		[
			{ role: "system", content: context },
			...messages.filter((m) => m.role === "user" || m.role === "assistant"),
			{
				role: "user",
				content: JSON.stringify({
					lastReply: {
						confirmation: lastPresentedRef(turn),
						text: turn.routed?.previousReply,
					},
					user: turn.utterance,
				}),
			},
		],
		schema,
	);
	if (
		!decision ||
		decision === "cut" ||
		typeof decision.confirmation !== "string" ||
		!refs.includes(decision.confirmation)
	)
		return null;
	const { choice, confirmation, toolchain, request } = decision;
	const call = (name: string, args: Record<string, unknown>) => ({
		id: turn.deps.id(),
		name,
		arguments: JSON.stringify(args),
	});
	if (choice === "approve") {
		const item = pending.confirmations.find(
			(c) => `c${c.ref}` === confirmation,
		);
		if (
			item &&
			(!toolchain || toolchain === item.toolchain) &&
			(!request || request === item.request)
		)
			return call("approve_confirmation", { confirmation });
		return null;
	}
	if (choice === "cancel" || choice === "clarify")
		return call("decline_confirmation", {
			confirmation,
			followUp: choice === "clarify" ? "revise" : "cancel",
		});
	if (
		choice === "revise" &&
		typeof toolchain === "string" &&
		candidates.includes(toolchain) &&
		typeof request === "string" &&
		request.trim()
	)
		return call("delegate", { toolchain, request, revises: confirmation });
	return null;
}

/** Buffer a pending reply until its text or its requested operation can go through the normal output path. */
export async function releasePendingReply(
	turn: Turn,
	messages: ChatMessage[],
	reply: { text: string; toolCalls: AgentToolCall[] },
	publish: (text: string) => void,
) {
	if (!reply.toolCalls.length) {
		const operation = await confirmationDecision(turn, messages).catch(() => {
			turn.signal.throwIfAborted();
			getLogger("dialogue").warn("dialogue.choice_failed", {
				kind: "confirmation",
			});
			return null;
		});
		turn.signal.throwIfAborted();
		if (operation) return operation;
	}
	if (reply.text) publish(reply.text);
	return null;
}
