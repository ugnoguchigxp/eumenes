import type { Database } from "bun:sqlite";
import type { ControlContract, Receipt } from "../../inference";
import type { Prepared } from "../../capabilities";
import type { BoundCommandSet } from "../contracts/toolchains";
import type { Run } from "../contracts";
import type { DialogueDeps } from "./context";
import { delegateConversation } from "./delegate-conversation";

export type CommandInput = {
	runId: string;
	revision: number;
	toolchainRevisionId: string;
	requestId: string;
	backend: string | undefined;
	toolIds: Record<string, string>;
	messages: Array<{ role: "system" | "user"; content: string }>;
	control: ControlContract;
	snapshot: unknown;
	/** The request the conversation handed over (or the interaction kept) for this chain. */
	request: string;
	/** Present for bound command toolchains: tools map to registered adapter operations. */
	boundSet?: BoundCommandSet;
	/** Present when this run resumes an interaction: the generation and epoch it started under. */
	interaction?: { id: string; generation: number; epoch: number };
};
/** The typed operation of a bound chain, as the agent runtime executes it (route "action"). */
export type BoundInvocation = {
	bindingRevisionId: string;
	adapterRef: string;
	packageRevisionId: string;
	toolRevisionId: string;
	operationName: string;
	input: Record<string, unknown>;
};
export type CommandOutput = {
	receipt: Receipt;
	command?: unknown;
	question?: string;
	answerSchema?: string;
};

/**
 * Apply the model's decision in the run's settlement transaction: keep a question, or hand the
 * typed operation to its executor (a fixed backend, or the agent runtime for a bound chain).
 * Throws a safe code; the caller rolls the whole decision back.
 */
export function applyCommand(
	deps: DialogueDeps,
	tx: Database,
	jobId: string,
	run: Run,
	input: CommandInput,
	result: CommandOutput,
	answerJob: (note?: string) => void,
) {
	const { agents, conversation } = deps;
	if (result.question) {
		// The sub-agent needs one value from the user: the answer asks it. A bound
		// chain keeps the question, atomically with this run's settlement.
		if (input.boundSet) {
			if (!deps.interactions) throw new Error("adapter_unavailable");
			deps.interactions.askInTransaction(tx, {
				run,
				interactionId: input.interaction?.id,
				toolchainRevisionId: input.toolchainRevisionId,
				set: input.boundSet,
				request: input.request,
				prompt: result.question,
				schemaRef: result.answerSchema ?? "builtin:answerText",
			});
		}
		deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
			outcome: "clarification_required",
		});
		answerJob(result.question);
	} else if (input.backend === "object-recognition") {
		if (!deps.objectRecognition) throw new Error("capability_unavailable");
		deps.objectRecognition.invokeInTransaction(
			tx,
			run.id,
			run.conversationId,
			result.command,
		);
		answerJob();
	} else if (input.backend === "dots") {
		if (!deps.delegation) throw new Error("dots_unavailable");
		deps.delegation.invokeInTransaction(
			tx,
			run,
			result.command as import("../contracts/delegation").DelegationCommand,
			input.snapshot,
		);
		answerJob();
	} else if (input.boundSet) {
		const bound = deps.toolchains?.bound;
		if (!agents || !bound) throw new Error("adapter_unavailable");
		const command = result.command as BoundInvocation;
		// The frozen package capability the agent runtime executes the operation with.
		const actionCapability = bound.prepareInTransaction(
			tx,
			run.id,
			input.boundSet,
			{ toolRevisionId: command.toolRevisionId, input: command.input },
		) as Prepared;
		const stamp = input.interaction
			? deps.interactions?.beginInvokeInTransaction(
					tx,
					input.interaction.id,
					run.id,
					command.input,
				)
			: undefined;
		const root = delegateConversation(
			tx,
			agents,
			conversation,
			run,
			{
				route: "action",
				request: input.request,
				command: stamp ? { ...command, stamp } : command,
			},
			{ parentJobId: jobId, actionCapability },
		);
		deps.toolchains!.linkTaskInTransaction(tx, run.id, root.taskId);
		if (input.interaction) {
			// The operation ran in this transaction: its receipt or its refusal is known.
			const result = agents.actionOutcomeInTransaction(tx, run.id);
			if (result)
				deps.interactions?.finishInvokeInTransaction(
					tx,
					input.interaction.id,
					result,
				);
		}
	} else {
		// Neither bound nor a known backend: nothing is run on a guess.
		throw new Error("adapter_unavailable");
	}
}
