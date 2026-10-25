import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import type { Viewing } from "../contracts/specialist";
import { runViewing } from "../repository";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import type { DialogueDeps } from "./context";

/** One tool as the command sub-agent is offered it. */
type CommandTool = {
	id: string;
	description: string;
	inputSchema: unknown;
};
/** What a command run reads before the model call: the request, the host data and the tools. */
export type CommandSource = {
	request: string;
	original: string;
	/** Present when the run resumes an interaction: its generation, epoch and past questions. */
	resume?: {
		generation: number;
		epoch: number;
		exchanges: Array<{ question: string; answer: unknown }>;
	};
	snapshot: unknown;
	tools: CommandTool[];
	/** For the fixed (unbound) backends: tool id to the operation the host names. */
	toolIds: Record<string, string>;
};

/**
 * The request, the host snapshot and the tools of one command run. A bound chain gets its
 * binding's tools and the adapter's snapshot; the two fixed backends keep their own. Anything
 * else is refused with a code: nothing is run on a guess.
 */
export function commandSource(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	set: ReturnType<ToolchainRoutingPort["commandSetInTransaction"]>,
	payload: { toolchainRevisionId: string; interactionId?: string },
	execution?: import("../../tool-runtime").ChildExecution,
): { ok: true; source: CommandSource } | { ok: false; code: string } {
	const { conversation, toolchains } = deps;
	if (!toolchains) return { ok: false, code: "toolchain_unavailable" };
	// A resumed run reads the interaction's frozen request and its questions and answers.
	let resume:
		| {
				generation: number;
				epoch: number;
				exchanges: Array<{ question: string; answer: unknown }>;
		  }
		| undefined;
	let request: string | undefined;
	let original: string | undefined;
	if (execution) {
		request = execution.request;
		original = execution.source.request;
		if (execution.resume)
			resume = {
				generation: execution.revision,
				epoch: execution.revision,
				exchanges: [
					{
						question: execution.resume.questionId,
						answer: execution.resume.input,
					},
				],
			};
	} else if (payload.interactionId) {
		const context = deps.interactions?.resumeContextInTransaction(
			tx,
			payload.interactionId,
			run.id,
		);
		if (!context?.ok) {
			return {
				ok: false,
				code: context ? context.code : "interaction_closed",
			};
		}
		if (context.chainRevisionId !== payload.toolchainRevisionId)
			return { ok: false, code: "version_invalidated" };
		resume = context;
		request = context.request;
		original = context.originalRequest ?? undefined;
	} else {
		request = toolchains.requestOfRunInTransaction(tx, run.id);
		const input = conversation.messageInTransaction(tx, run.inputMessageId);
		original =
			input?.message.conversationId === run.conversationId
				? input.message.text
				: undefined;
	}
	if (!request || !original)
		return { ok: false, code: "required_context_missing" };
	let snapshot: unknown = null;
	let tools: Array<{
		id: string;
		description: string;
		inputSchema: unknown;
	}>;
	const toolIds: Record<string, string> = {};
	if (set.binding) {
		// Bound chain: tools are the binding's registered operations; the host adapter
		// supplies the snapshot. Nothing about the domain is known here.
		const bound = toolchains.bound;
		if (!bound) return { ok: false, code: "adapter_unavailable" };
		try {
			snapshot = bound.snapshotInTransaction(
				tx,
				set.binding.bindingRevisionId,
				{ conversationId: run.conversationId },
			);
		} catch {
			return { ok: false, code: "adapter_unavailable" };
		}
		tools = set.binding.tools.map((t) => ({
			id: t.id,
			description: t.summary,
			inputSchema: t.schema,
		}));
	} else if (set.backend === "object-recognition") {
		snapshot = deps.objectRecognition?.snapshotInTransaction(
			tx,
			run.conversationId,
			runViewing(tx, run.id) as Viewing | null,
		);
		tools = set.tools.map((t) => {
			toolIds[t.id] = "manage";
			return { id: t.id, description: t.summary, inputSchema: t.schema };
		});
	} else {
		// Neither bound nor a known backend: nothing is run on a guess.
		return { ok: false, code: "adapter_unavailable" };
	}
	return {
		ok: true,
		source: {
			request,
			original,
			resume,
			snapshot,
			tools,
			toolIds,
		},
	};
}
