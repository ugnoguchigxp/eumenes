import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import type { ConversationService } from "../../conversation";
import { toolchainRuntimeOf, toolchainBuiltins } from "../../capabilities";
import type { Run } from "../contracts";
import { linkAgent } from "../repository";
import { conversationUrls } from "./conversation-urls";
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
		route: "web" | "history" | "timer";
		request: string;
		packageRevisionId?: string;
		researcher?: "codex_luna";
		command?: unknown;
	},
	context: {
		parentJobId: string;
		authorizedUrls?: string[];
		actionSnapshot?: unknown;
		timerCapability?: ReturnType<
			AgentRuntime["conversationContextInTransaction"]
		>["timerCapability"];
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
			urls: selected.route === "web" ? context.authorizedUrls : undefined,
		},
		deadline: Date.parse(run.deadlineAt!),
		parentJobId: context.parentJobId,
		actionSnapshot: context.actionSnapshot,
		timerCapability: context.timerCapability,
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
	const context = agents?.conversationContextInTransaction?.(db, run.id);
	const ready = (requires: string | undefined) =>
		requires === undefined
			? !!agents
			: requires === "luna"
				? !!context?.lunaEnabled
				: requires === "timers"
					? !!context?.timersEnabled
					: requires === "music"
						? !!deps.music
						: requires === "dots"
							? available.dots
							: false;
	const ids = toolchainBuiltins
		.map((d) => d.id)
		.filter((id) => {
			const runtime = toolchainRuntimeOf(id);
			return !!runtime && ready(runtime.requires);
		});
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
		},
		authorizedUrls: conversationUrls(turns.map((m) => m.content)),
	};
}
