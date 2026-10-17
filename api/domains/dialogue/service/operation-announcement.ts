import type { Receipt } from "../../inference";
import { chosen, type Candidates } from "./selection-trace";
import type { FirstRound } from "./initial-decision";
import { generateSelection } from "./generate-selection";
import type { DialogueDeps, GenerateInput } from "./context";
import { byId, saveAnnouncement } from "../repository";
import { validAttachmentContext } from "./attachment-context";
import { operationRejection } from "./operation-authority";
import { announcementSchema } from "./conversation-tools";
import { conversationOutput } from "./conversation-output";

/** Persist before publish/settle. The later delegation must still recheck the same authority. */
async function announceOperation(
	deps: DialogueDeps,
	input: GenerateInput,
	selected: { revisionId: string; announcement: string },
	receipt: Receipt | undefined,
	recallPins: Array<{ messageId: string; digest: string }>,
	signal: AbortSignal,
) {
	if (!deps.toolchains || input.agent)
		throw new Error("invalid_conversation_operation");
	const text = announcementSchema.parse(selected.announcement);
	conversationOutput(() => {}).finish(text);
	await deps.store.write((tx) => {
		signal.throwIfAborted();
		const run = byId(tx, input.runId);
		if (!run || run.status !== "running" || run.revision !== input.revision)
			throw new Error("run_changed");
		if (!validAttachmentContext(deps, tx, input, run.conversationId))
			throw new Error("attachment_source_unavailable");
		const rejected = operationRejection(tx, {
			inference: deps.larm,
			receipt,
			memory: deps.memory,
			memoryWindow: input.memory,
			recallPins,
			goals: deps.goals,
			goalsLayer: input.goals,
			settle: { runId: run.id },
		});
		if (rejected) throw new Error(rejected);
		try {
			deps.toolchains!.resolveInTransaction(tx, selected.revisionId);
		} catch {
			throw new Error("toolchain_unavailable");
		}
		saveAnnouncement(
			tx,
			run.id,
			run.revision,
			`${run.revision}:${receipt?.attemptId ?? "generated"}`,
			text,
		);
	});
}

/**
 * The hand-over of a request the first round gave to a toolchain. The notice it chose is checked, saved and
 * delivered first (a spoken one starts reading here); the second round, which writes the request for the
 * specialist, runs while it is read, and the delegation waits for the reading to finish. A second round that
 * fails stops the reading and fails the run: the notice already delivered is no sign that the work was handed over.
 * A reading that fails first stops the second round the same way, and the run fails with the reading's error.
 */
export async function announceAndSelect(
	deps: DialogueDeps,
	input: GenerateInput,
	handover: {
		found: Candidates;
		analysis: FirstRound & { next: "toolchain" };
		/** The first round's receipt and whether its output needed the one repair. */
		first: { receipt?: Receipt; repaired: boolean };
		signal: AbortSignal;
		repair: () => void;
		publish: () => void;
	},
) {
	const { found, analysis, first, signal, repair, publish } = handover;
	await announceOperation(
		deps,
		input,
		{
			revisionId: analysis.card.revisionId,
			announcement: analysis.announcement,
		},
		first.receipt,
		[],
		signal,
	);
	publish();
	const run = deps.store.read((tx) => byId(tx, input.runId));
	if (!run) throw new Error("run_changed");
	if (run.utteranceId && !deps.deliverAnnouncement)
		throw new Error("announcement_delivery_unavailable");
	const stop = new AbortController();
	// A notice that cannot be delivered ends the run, so the second round stops at once instead of running on.
	const selectionStop = new AbortController();
	let failure: { error: unknown } | undefined;
	const delivered = (
		deps.deliverAnnouncement?.(run, AbortSignal.any([signal, stop.signal])) ??
		Promise.resolve()
	).catch((error) => {
		failure = { error };
		selectionStop.abort();
	});
	let selected: Awaited<ReturnType<typeof generateSelection>>;
	try {
		selected = await generateSelection(
			deps,
			input,
			found,
			analysis,
			AbortSignal.any([signal, selectionStop.signal]),
			repair,
		);
	} catch (error) {
		const undelivered = failure;
		stop.abort();
		await delivered;
		throw undelivered && !signal.aborted ? undelivered.error : error;
	}
	await delivered;
	if (failure) throw failure.error;
	signal.throwIfAborted();
	const { decision, generated } = selected;
	if (!generated.operation) throw new Error("invalid_conversation_operation");
	return {
		...generated,
		operation: generated.operation,
		selection: chosen(decision, {
			operation: generated.operation,
			repaired: first.repaired || generated.repaired,
		}),
		recallPins: decision.recallPins,
	};
}
