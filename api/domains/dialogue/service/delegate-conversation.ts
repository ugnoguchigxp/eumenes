import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import type { Prepared } from "../../capabilities";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import { linkAgent } from "../repository";
import type { DialogueDeps } from "./context";

/** How much of the preceding conversation joins the current utterance as the retrieval query. */
const QUERY_CONTEXT_BYTES = 1024;
const QUERY_CONTEXT_TURNS = 4;

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
		route: "web" | "history" | "action";
		request: string;
		packageRevisionId?: string;
		researcher?: "codex_luna";
		command?: unknown;
	},
	context: {
		parentJobId: string;
		/** The frozen package capability a bound operation runs with (route "action"). */
		actionCapability?: Prepared;
	},
) {
	const original = conversation
		.messagesInTransaction(db, run.conversationId)
		.find((m) => m.id === run.inputMessageId)!.text;
	const root = agents.startInTransaction(db, {
		rootRunId: run.id,
		input: {
			kind: selected.route,
			question: selected.request,
			originalRequest: original,
			...(selected.packageRevisionId
				? { packageRevisionId: selected.packageRevisionId }
				: {}),
			...(selected.researcher ? { researcher: selected.researcher } : {}),
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
 * The routing input of a new conversation decision: the request text for retrieval and the
 * toolchains whose runtime is available now. Nothing is offered to scheduled prompts or while
 * an agent task already belongs to the run.
 */
export function prepareRouting(
	db: Database,
	deps: DialogueDeps,
	run: Run,
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	available: { dots: boolean },
) {
	const { agents, toolchains } = deps;
	if (!toolchains || run.agentTaskId || run.sourceKind === "schedule")
		return undefined;
	const context = agents?.conversationContextInTransaction?.(db);
	const ready = (requires: string | undefined) =>
		requires === undefined
			? !!agents
			: requires === "luna"
				? !!context?.lunaEnabled
				: requires === "excalidraw"
					? !!deps.excalidraw
					: requires === "object-recognition"
						? !!deps.objectRecognition
						: requires === "image"
							? !!deps.image
							: requires === "music"
								? !!deps.music
								: requires === "dots"
									? available.dots
									: false;
	// Bound chains are offered while their adapter is available; the others by host capability.
	const ids = toolchains
		.catalogInTransaction(db)
		.filter(({ runtime }) =>
			runtime.binding ? runtime.binding.available : ready(runtime.requires),
		)
		.map((entry) => entry.id);
	const turns = messages.filter((m) => m.role !== "system");
	const current = turns.at(-1)?.content ?? "";
	let before = "";
	for (const m of turns.slice(0, -1).slice(-QUERY_CONTEXT_TURNS).reverse()) {
		const next = `${m.content}\n${before}`;
		if (new TextEncoder().encode(next).length > QUERY_CONTEXT_BYTES) break;
		before = next;
	}
	return {
		routing: {
			query: (before ? before + "\n" : "") + current,
			available: ids,
			conversationId: run.conversationId,
			utteranceId: run.utteranceId ?? null,
			requestId: run.requestId ?? null,
			openQuestions: toolchains.bound
				? (deps.interactions?.openQuestionsInTransaction(
						db,
						run.conversationId,
					) ?? [])
				: [],
		},
	};
}
