import type { Receipt } from "../../inference";
import { isSystemPrompt } from "../contracts";
import type { DialogueDeps } from "./context";
import { type MemoryArgs, type ParsedCall } from "./generation-tools";

import {
	createExecutorContext,
	type ExecutorContext,
	type ToolExecutor,
	type ToolOutcome,
} from "./executor-context";
import { delegate } from "./executor-delegation";
import { answered, find } from "./executor-search";
import { work } from "./executor-work";
import { read } from "./executor-read";

export async function memory(
	x: ExecutorContext,
	call: ParsedCall,
	args: MemoryArgs,
): Promise<ToolOutcome> {
	const { deps, input, current, acted, handle, actionKey } = x;
	const { store } = deps;
	// Reading memory is the read tool `read_memory`'s. A request stands on the user's own words: a generation without a new utterance cannot make one.
	const messageId =
		input.final.kind === "utterances"
			? input.final.messageIds.at(-1)
			: undefined;
	return store.write((tx) => {
		if (!deps.steward)
			return { result: { accepted: false, code: "steward_unavailable" } };
		const run = current(tx);
		if (!messageId || isSystemPrompt(run.sourceKind))
			return { result: { accepted: false, code: "utterance_required" } };
		const target = `memory.request:${args.kind}:${args.what}`;
		let accepted: { id: string };
		try {
			accepted = deps.steward.requestInTransaction(tx, {
				conversationId: input.conversationId,
				kind: args.kind,
				what: args.what,
				...(args.detail ? { detail: args.detail } : {}),
				sourceRef: messageId,
				requestId: actionKey(target),
			});
		} catch (error) {
			return {
				result: {
					accepted: false,
					code:
						error instanceof Error && /^[a-z_]+$/.test(error.message)
							? error.message
							: "request_failed",
				},
			};
		}
		// The event keeps the kind and the receipt; what is to be remembered or forgotten is the steward's alone.
		acted(tx, target, {
			action: "memory.request",
			kind: args.kind,
			requestId: accepted.id,
		});
		handle(tx);
		return {
			result: { accepted: true, requestId: accepted.id },
		};
	});
}

/**
 * The host side of the fixed tools (the ContextWindow specification, sections 6.1, 6.5, 6.7, 9 and 14): each
 * call runs here and its result goes back to the model. A delegation that hands work over ends the generation.
 */
export function createGenerationExecutor(
	deps: DialogueDeps,
	ctx: Parameters<typeof createExecutorContext>[1],
) {
	const x = createExecutorContext(deps, ctx);
	const execute: ToolExecutor = async (call, { signal, receipt, exchange }) => {
		x.state.receipt = receipt;
		x.state.exchange = exchange;
		switch (call.name) {
			case "memory":
				return memory(x, call, call.args);
			case "find_toolchain":
				return find(x, call, call.args.query, signal);
			case "delegate":
				return delegate(x, call, call.args, signal);
			case "work":
				return work(x, call, call.args);
			default:
				return read(x, call);
		}
	};
	/**
	 * The user declined the confirmation `c<ref>` (the routed turn's pending turn, the local harness rebuild plan,
	 * section 4.4): closed as an action of this run, with the same authority checks as every other. False when it was
	 * no longer open.
	 */
	const decline = (ref: number, receipt?: Receipt) => {
		x.state.receipt = receipt;
		return deps.store.write((tx) => {
			const run = x.current(tx);
			const closed =
				deps.work?.withdrawConfirmationInTransaction(
					tx,
					run.conversationId,
					ref,
				) ?? false;
			if (closed) {
				x.handle(tx);
				x.acted(tx, `decline:c${ref}`, {
					action: "decline",
					confirmation: `c${ref}`,
				});
			}
			return closed;
		});
	};
	return {
		execute,
		decline,
		handover: () => x.state.handover,
		answered: (refused?: boolean) => answered(x, refused),
	};
}
