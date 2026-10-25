import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import type { Prepared } from "../../capabilities";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import { linkAgent } from "../repository";
import type { DialogueDeps } from "./context";

/**
 * Start the research sub-agent of a toolchain. The saved human origin is established in the
 * same transaction; the toolchain's package fixes the profile, SKILL and tools.
 */
export function delegateConversation(
	db: Database,
	agents: AgentRuntime,
	conversation: ConversationService,
	run: Run,
	selected: {
		route: "web" | "history" | "world" | "action";
		request: string;
		packageRevisionId?: string;
		command?: unknown;
	},
	context: {
		parentJobId: string;
		/** The frozen package capability a bound operation runs with (route "action"). */
		actionCapability?: Prepared;
	},
) {
	const original =
		conversation.messageInTransaction(db, run.inputMessageId)?.message.text ??
		selected.request;
	const root = agents.startInTransaction(db, {
		rootRunId: run.id,
		input: {
			kind: selected.route,
			question: selected.request,
			originalRequest: original,
			...(selected.packageRevisionId
				? { packageRevisionId: selected.packageRevisionId }
				: {}),
			...(selected.command ? { command: selected.command } : {}),
		},
		deadline: Date.parse(run.deadlineAt!),
		parentJobId: context.parentJobId,
		actionCapability: context.actionCapability,
		// Requirement profiles are chosen inside the history toolchain, never by the conversation.
		requirementProfiles: [],
		onCreated: (taskId) => linkAgent(db, run.id, taskId, context.parentJobId),
	});
	linkAgent(db, run.id, root.taskId, root.jobId);
	return root;
}

/**
 * The toolchains whose runtime is available now: bound chains while their adapter is available, the others by
 * host capability. A search offers only these.
 */
export function availableToolchainsInTransaction(
	deps: DialogueDeps,
	db: Database,
	run: Run,
): Set<string> {
	const { agents, toolchains } = deps;
	if (!toolchains) return new Set();
	const ready = (requires: string | undefined) =>
		requires === undefined || requires === "world"
			? !!agents
			: requires === "excalidraw"
				? !!deps.excalidraw
				: requires === "object-recognition"
					? !!deps.objectRecognition
					: requires === "image"
						? !!deps.image
						: requires === "music"
							? !!deps.music
							: requires === "dots"
								? !!deps.delegation &&
									deps.delegation.prepareInTransaction(db, run).available !==
										false
								: false;
	return new Set(
		toolchains
			.catalogInTransaction(db)
			.filter(({ runtime }) =>
				runtime.binding ? runtime.binding.available : ready(runtime.requires),
			)
			.map((entry) => entry.id),
	);
}
