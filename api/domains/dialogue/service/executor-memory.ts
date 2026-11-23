import type { Database } from "bun:sqlite";
import type { ImmediateRejection } from "../../memory";
import { isSystemPrompt } from "../contracts";
import type { MemoryTargetRequest } from "../contracts";
import type { ExecutorContext, ToolOutcome } from "./executor-context";
import type { MemoryArgs, ParsedCall } from "./generation-tools";
import { hideExcludedInTransaction } from "./forget-hide";
import { holdForTargetsInTransaction } from "./targets-hold";

/** A call the host did not apply, with the reason the agent reads (it repairs its arguments in the same reply). */
const rejected = (reason: string): ToolOutcome => ({
	result: { accepted: false, status: "rejected", reason },
});
const applied = (extra: Record<string, unknown> = {}): ToolOutcome => ({
	result: { accepted: true, status: "applied", ...extra },
});
/** The target is named in words (no short reference): the agency decides it once the run ends. */
const resolving = (): ToolOutcome => ({
	result: { accepted: true, status: "resolving" },
});

const needsResolution = (args: MemoryArgs) =>
	!args.ref &&
	(args.kind === "correct" ||
		args.kind === "forget" ||
		args.kind === "suppress");

const normalized = (text: string) =>
	text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * What one request is, within a run: a remembered fact (its kind and key), a change of a record named by its
 * reference, or the words of a target not yet named. The same request asked again in other words (a regenerated
 * reply) is the first one, so it is applied once.
 */
function requestKey(args: MemoryArgs): string {
	if (args.kind === "remember" && args.memory)
		return `remember:${args.memory.kind}:${normalized(args.memory.semanticKey ?? "")}`;
	if (args.kind === "goal") return `goal:${normalized(args.what)}`;
	return args.ref
		? `${args.kind}:${args.ref}`
		: `${args.kind}:${normalized(args.what)}`;
}

/**
 * The memory tool (the memory architecture redesign, sections 5.1 and 8). Everything is applied here, in one writer
 * transaction with the run's authority checked, through the memory's immediate operations, and the result goes back
 * to the model at once: a refusal says why, so the model repairs its arguments in the same reply. The run's id is
 * the `sourceRunId` of every change, so its own changes never expire its reply (the adoption check leaves them out).
 */
export async function memory(
	x: ExecutorContext,
	_call: ParsedCall,
	args: MemoryArgs,
): Promise<ToolOutcome> {
	const { deps, input, current, actedOnce, handle, actionKey } = x;
	// A request stands on the user's own words: a generation without a new utterance cannot make one. The newest
	// utterance first: a quote is looked for in each.
	const messageIds =
		input.final.kind === "utterances"
			? [...input.final.messageIds].reverse()
			: [];
	return deps.store.write((tx) => {
		const run = current(tx);
		const latest = messageIds[0];
		if (!latest || isSystemPrompt(run.sourceKind))
			return rejected("utterance_required");
		const target = `memory.request:${requestKey(args)}`;
		tx.exec("SAVEPOINT memory_request");
		let outcome: ToolOutcome;
		try {
			const first = actedOnce(tx, target, {
				action: "memory.request",
				kind: args.kind,
			});
			// A retried generation asks again: the first call stands (a withdrawal must not take back another request).
			outcome = first.created
				? args.kind === "goal"
					? goal(x, tx, args, latest)
					: apply(x, tx, args, messageIds, actionKey(target))
				: needsResolution(args)
					? resolving()
					: applied();
		} catch (error) {
			tx.exec("ROLLBACK TO memory_request");
			tx.exec("RELEASE memory_request");
			return rejected(
				error instanceof Error && /^[a-z_]+$/.test(error.message)
					? error.message
					: "request_failed",
			);
		}
		const done = (outcome.result as { accepted: boolean }).accepted;
		if (!done) tx.exec("ROLLBACK TO memory_request");
		tx.exec("RELEASE memory_request");
		if (done) handle(tx);
		return outcome;
	});
}

/** A goal request is the steward's, as before (the goal path is not part of the immediate layer). */
function goal(
	x: ExecutorContext,
	tx: Database,
	args: MemoryArgs,
	sourceRef: string,
): ToolOutcome {
	const { deps, input, actionKey } = x;
	if (!deps.steward) return rejected("steward_unavailable");
	const accepted = deps.steward.requestInTransaction(tx, {
		conversationId: input.conversationId,
		kind: "goal",
		what: args.what,
		...(args.detail ? { detail: args.detail } : {}),
		sourceRef,
		requestId: actionKey(`memory.request:goal:${args.what}`),
	});
	return { result: { accepted: true, requestId: accepted.id } };
}

/** The first outcome that is not a quote that stands in no utterance (the quote may stand in an earlier one). */
function grounded<T extends { status: string }>(
	messageIds: readonly string[],
	run: (messageId: string) => T | { status: "rejected"; reason: string },
) {
	let last!: T | { status: "rejected"; reason: string };
	for (const messageId of messageIds) {
		last = run(messageId);
		if (
			last.status !== "rejected" ||
			(last as { reason: string }).reason !== "quote_mismatch"
		)
			return last;
	}
	return last;
}

const refused = (outcome: {
	status: "rejected";
	reason: ImmediateRejection | string;
}) => rejected(outcome.reason);

function apply(
	x: ExecutorContext,
	tx: Database,
	args: MemoryArgs,
	messageIds: readonly string[],
	requestId: string,
): ToolOutcome {
	const { deps, input } = x;
	const mem = deps.memory;
	if (!mem) return rejected("memory_unavailable");
	const base = {
		conversationId: input.conversationId,
		sourceRunId: input.runId,
	};
	const record = args.memory;
	/** The short reference of a version this call made (the model may correct or withdraw it later). */
	const refOf = (itemId: string, revision: number) =>
		input.memory
			? mem.shortRefs.assignInTransaction(tx, {
					conversationId: input.conversationId,
					windowKey: input.memory.refsKey,
					items: [{ itemId, revision }],
				})[0]?.ref
			: undefined;
	const written = (outcome: {
		itemId: string;
		revision: number;
	}): ToolOutcome => {
		const ref = refOf(outcome.itemId, outcome.revision);
		return applied(ref ? { ref } : {});
	};
	const fields = () => ({
		text: record!.text,
		polarity: record!.polarity ?? ("affirmed" as const),
		...(record!.validFrom ? { validFrom: record!.validFrom } : {}),
		...(record!.validUntil ? { validUntil: record!.validUntil } : {}),
	});
	switch (args.kind) {
		case "remember": {
			const outcome = grounded(messageIds, (messageId) =>
				mem.rememberExplicitInTransaction(tx, {
					...base,
					messageId,
					quote: args.quote!,
					kind: record!.kind!,
					semanticKey: record!.semanticKey!,
					subject: "self",
					...fields(),
				}),
			);
			return outcome.status === "rejected"
				? refused(outcome)
				: written(outcome);
		}
		case "correct": {
			if (!args.ref) return pending(x, tx, args, messageIds, requestId);
			const outcome = grounded(messageIds, (messageId) =>
				mem.correctExplicitInTransaction(tx, {
					...base,
					messageId,
					quote: args.quote!,
					target: { ref: args.ref! },
					...fields(),
				}),
			);
			return outcome.status === "rejected"
				? refused(outcome)
				: written(outcome);
		}
		case "suppress": {
			if (!args.ref) return pending(x, tx, args, messageIds, requestId);
			const outcome = mem.suppressInTransaction(tx, {
				...base,
				target: { ref: args.ref },
			});
			return outcome.status === "rejected" ? refused(outcome) : applied();
		}
		case "withdraw": {
			const outcome = mem.withdrawExplicitInTransaction(tx, {
				...base,
				...(args.ref ? { target: { ref: args.ref } } : {}),
			});
			return outcome.status === "rejected" ? refused(outcome) : applied();
		}
		case "forget": {
			// The request is kept in the steward's inbox either way: it ends there, once the closure delete is done.
			const sourceRef = messageIds[0]!;
			const queued = deps.steward?.requestInTransaction(tx, {
				conversationId: input.conversationId,
				kind: "forget",
				what: args.what,
				...(args.detail ? { detail: args.detail } : {}),
				sourceRef,
				requestId,
			});
			if (!args.ref) return pending(x, tx, args, messageIds, requestId);
			const outcome = mem.excludeForForgetInTransaction(tx, {
				...base,
				targets: [{ ref: args.ref }],
			});
			if (outcome.status === "rejected") return refused(outcome);
			// What the excluded records stand on leaves the history now (the closure delete removes it for good).
			hideExcludedInTransaction(deps, tx, {
				messageIds: outcome.evidenceMessageIds,
				itemIds: outcome.itemIds,
			});
			deps.agency?.memoryExcludedInTransaction?.(tx, {
				conversationId: input.conversationId,
				itemIds: outcome.itemIds,
				messageIds: outcome.evidenceMessageIds,
			});
			// What this call excluded was in its own prompt: its closure delete (the steward does not wait for the run)
			// blocking those messages does not expire the reply that asked for it.
			if (input.memory)
				input.memory.blockedAtPrepare = [
					...new Set([
						...(input.memory.blockedAtPrepare ?? []),
						...outcome.evidenceMessageIds,
					]),
				];
			// The words this call took out of the input were in its own prompt: the run goes on, its input is the new one.
			input.inputRevision =
				deps.conversation.input.cutInTransaction(tx, input.conversationId)
					?.revision ?? 0;
			if (queued)
				deps.steward?.excludedInTransaction(tx, {
					id: queued.id,
					conversationId: input.conversationId,
					exclusion: {
						itemIds: outcome.itemIds,
						messageIds: outcome.evidenceMessageIds,
						claimIds: [],
						entityIds: [],
						goalIds: [],
					},
				});
			return applied();
		}
		default:
			return rejected("invalid_input");
	}
}

/** A target named in words: kept for the agency, which settles it after the run (the model is told "resolving"). */
function pending(
	x: ExecutorContext,
	tx: Database,
	args: MemoryArgs,
	messageIds: readonly string[],
	requestId: string,
): ToolOutcome {
	const { deps, input } = x;
	if (!deps.memoryTargets) return rejected("target_resolution_unavailable");
	const request: MemoryTargetRequest = {
		conversationId: input.conversationId,
		runId: input.runId,
		kind: args.kind as "correct" | "forget" | "suppress",
		what: args.what,
		...(args.detail ? { detail: args.detail } : {}),
		messageIds: [...messageIds].reverse(),
		...(args.quote ? { quote: args.quote } : {}),
		...(args.memory
			? {
					memory: {
						text: args.memory.text,
						...(args.memory.polarity ? { polarity: args.memory.polarity } : {}),
						...(args.memory.validFrom
							? { validFrom: args.memory.validFrom }
							: {}),
						...(args.memory.validUntil
							? { validUntil: args.memory.validUntil }
							: {}),
					},
				}
			: {}),
		requestId,
	};
	// Kept in the steward (it survives a restart) and told to the agency; a forget holds the conversation's next
	// generations until the agency has settled it, so what it excludes is not in their prompt.
	deps.steward?.targetRequestInTransaction(tx, { id: requestId, request });
	if (args.kind === "forget")
		holdForTargetsInTransaction(deps, tx, input.conversationId, requestId);
	deps.memoryTargets.requestInTransaction(tx, request);
	return resolving();
}
