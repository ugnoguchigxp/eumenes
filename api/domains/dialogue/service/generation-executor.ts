import {
	beginConfirmationRevision,
	cancelConfirmationRevision,
} from "../repository/confirmation-revisions";
import { currentRevisions } from "./confirmation-revisions";
import { currentSources, offerSources } from "./conversation-offers";
import { CONFIRMATION_TTL_MS } from "./work-ledger";
import { measureStage } from "../../../infrastructure/performance";
import type { Receipt } from "../../inference";
import type { DialogueDeps } from "./context";

import { createExecutorContext, type ToolExecutor } from "./executor-context";
import { delegate } from "./executor-delegation";
import { memory } from "./executor-memory";
import { read } from "./executor-read";
import { answered, find } from "./executor-search";
import { work } from "./executor-work";

/**
 * The host side of the fixed tools (the ContextWindow specification, sections 6.1, 6.5, 6.7, 9 and 14): each
 * call runs here and its result goes back to the model. A delegation that hands work over ends the generation.
 */
export function createGenerationExecutor(
	deps: DialogueDeps,
	ctx: Parameters<typeof createExecutorContext>[1],
) {
	const x = createExecutorContext(deps, ctx);
	const execute: ToolExecutor = (
		call,
		{ signal, receipt, exchange, routedSteps },
	) =>
		measureStage(
			"dialogue",
			"tool_execution",
			async () => {
				x.state.receipt = receipt;
				x.state.exchange = exchange;
				switch (call.name) {
					case "memory":
						return memory(x, call, call.args);
					case "find_toolchain":
						return find(x, call, call.args.query, signal);
					case "delegate":
						return delegate(x, call, call.args, signal, routedSteps);
					case "work":
						return work(x, call, call.args);
					default:
						return read(x, call);
				}
			},
			{ kind: call.name },
		);
	/**
	 * The user declined the confirmation `c<ref>` (the routed turn's pending turn, the local harness rebuild plan,
	 * section 4.4): closed as an action of this run, with the same authority checks as every other. False when it was
	 * no longer open.
	 */
	const decline = (ref: number, receipt?: Receipt, revise = false) => {
		x.state.receipt = receipt;
		return deps.store.write((tx) => {
			const run = x.current(tx);
			const existing = currentRevisions(deps, tx, run.conversationId).find(
				(d) => d.row.ref === ref,
			);
			if (revise) {
				const row = deps.work?.confirmationByRefInTransaction(
					tx,
					run.conversationId,
					ref,
				);
				if (!row || !deps.work?.confirmationStatementInTransaction(tx, row))
					return false;
				const corrections = [
					...new Set([...(existing?.corrections ?? []), ...x.origin]),
				];
				const ids = [...new Set([...(row.messageIds ?? []), ...corrections])];
				const at = deps.clock();
				const versions = offerSources(deps, tx, ids);
				if (
					!currentSources(deps, tx, run.conversationId, versions) ||
					!beginConfirmationRevision(
						tx,
						run.conversationId,
						ref,
						at,
						new Date(Date.parse(at) + CONFIRMATION_TTL_MS).toISOString(),
						versions,
						corrections,
						!!existing,
					)
				)
					return false;
				x.acted(tx, `revise:c${ref}`, {
					action: "revise",
					confirmation: `c${ref}`,
				});
				return true;
			}
			const closed = existing
				? cancelConfirmationRevision(tx, run.conversationId, ref, deps.clock())
				: (deps.work?.withdrawConfirmationInTransaction(
						tx,
						run.conversationId,
						ref,
					) ?? false);
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
