import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent-runtime";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import { linkAgent } from "../repository";
import {
	appendConversationPolicy,
	conversationTools,
} from "./conversation-tools";
import { conversationUrls } from "./conversation-urls";
import type { ConversationOperation } from "./conversation-tools";

/** Establish the saved human origin before a local action runs, in the same transaction. */
export function delegateConversation(
	db: Database,
	agents: AgentRuntime,
	conversation: ConversationService,
	run: Run,
	selected: ConversationOperation,
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
			...selected,
			question: "question" in selected ? selected.question : original,
			originalRequest: original,
			urls: selected.kind === "web" ? context.authorizedUrls : undefined,
		},
		deadline: Date.parse(run.deadlineAt!),
		parentJobId: context.parentJobId,
		actionSnapshot: context.actionSnapshot,
		timerCapability: context.timerCapability,
		onCreated: (taskId) => linkAgent(db, run.id, taskId, context.parentJobId),
	});
	linkAgent(db, run.id, root.taskId, root.jobId);
	return root;
}

export function prepareConversation(
	db: Database,
	agents: AgentRuntime | undefined,
	run: Run,
	messages: Parameters<typeof appendConversationPolicy>[0],
) {
	if (!agents || run.agentTaskId || run.sourceKind === "schedule") return {};
	const context = agents.conversationContextInTransaction?.(db, run.id) ?? {
		timersEnabled: false,
		timers: null,
		timerCapability: undefined,
	};
	appendConversationPolicy(messages, context.timers);
	return {
		tools: conversationTools(context.timersEnabled),
		actionSnapshot: context.timers,
		timerCapability: context.timerCapability,
		authorizedUrls: conversationUrls(
			messages.filter((m) => m.role !== "system").map((m) => m.content),
		),
	};
}
