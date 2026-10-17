import type { Receipt } from "../../inference";
import { chosen, type prepareDecision } from "./selection-trace";
import type { generateConversation } from "./conversation-generation";
import type { DialogueDeps, GenerateInput } from "./context";
import { byId, saveAnnouncement } from "../repository";
import { validAttachmentContext } from "./attachment-context";
import { operationRejection } from "./operation-authority";
import {
	announcementSchema,
	type ConversationOperation,
} from "./conversation-tools";
import { conversationOutput } from "./conversation-output";

/** Persist before publish/settle. The later delegation must still recheck the same authority. */
async function announceOperation(
	deps: DialogueDeps,
	input: GenerateInput,
	operation: ConversationOperation,
	receipt: Receipt | undefined,
	recallPins: Array<{ messageId: string; digest: string }>,
	signal: AbortSignal,
) {
	if (!deps.toolchains || input.agent)
		throw new Error("invalid_conversation_operation");
	const text = announcementSchema.parse(operation.announcement);
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
			deps.toolchains!.resolveInTransaction(tx, operation.revisionId);
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

/** Finish selection by publishing the adopted notice before returning the executable operation. */
export async function announceSelection(
	deps: DialogueDeps,
	input: GenerateInput,
	selected: {
		generated: Awaited<ReturnType<typeof generateConversation>>;
		decision: Awaited<ReturnType<typeof prepareDecision>>;
		signal: AbortSignal;
		publish: () => void;
	},
) {
	const { generated, decision, signal, publish } = selected;
	const operation = generated.operation;
	if (!operation) throw new Error("invalid_conversation_operation");
	const { recallPins } = decision;
	await announceOperation(
		deps,
		input,
		operation,
		generated.receipt,
		recallPins,
		signal,
	);
	publish();
	const run = deps.store.read((tx) => byId(tx, input.runId));
	if (!run) throw new Error("run_changed");
	if (run.utteranceId && !deps.deliverAnnouncement)
		throw new Error("announcement_delivery_unavailable");
	await deps.deliverAnnouncement?.(run, signal);
	signal.throwIfAborted();
	return {
		...generated,
		operation,
		selection: chosen(decision, generated),
		recallPins,
	};
}
