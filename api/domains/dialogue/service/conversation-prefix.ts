import type { Database } from "bun:sqlite";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import {
	estimateJsonTokens,
	estimateTextTokens,
	planWindow,
} from "../../inference";
import type { ConversationEvent } from "../../continuity";
import type { WindowSnapshot } from "../../memory";
import { latestConversationId } from "../repository";
import type { DialogueDeps } from "./context";
import {
	renderDocument,
	type ContextDocument,
	type DocumentRefs,
	type TodoItem,
} from "./context-document";
import { systemText } from "./context-system";
import { toolchainTitlesInTransaction } from "./delegate-conversation";
import { generationTools } from "./generation-tools";
import { resourceLinesInTransaction } from "./resource-context";

/** The system part of every call on the conversation's prompt: the agent's system, then the host's rules. */
export function conversationSystem(deps: DialogueDeps, tx: Database): string {
	const persona = deps.larm.snapshotInTransaction?.(tx).general ?? {
		agentName: "",
		userName: "",
		persona: "butler" as const,
	};
	return `${deps.conversationAgent.system()}\n${systemText(persona, toolchainTitlesInTransaction(deps, tx))}`;
}

/**
 * The `<memory>` budget of every call on the conversation's prompt: the plan of the saved model's window with the
 * conversation's own fixed part (its system and tools), capped by memory's plan. A generation plans its run's window
 * the same way (`generation-prepare.ts`), so both render the same `<memory>` while the model is the same.
 */
export function profileLimitOf(
	deps: DialogueDeps,
	system: string,
	window = deps.memory?.windowPlan().window,
): number {
	const memory = deps.memory?.windowPlan();
	if (!memory || window === undefined) return Number.POSITIVE_INFINITY;
	const fixed =
		estimateTextTokens(system) + estimateJsonTokens(generationTools);
	return Math.min(
		planWindow({ window, fixed }).sections.profile,
		memory.sections.profile,
	);
}

/** The current year in Asia/Tokyo: the document writes dates of this year without it. */
export const tokyoYear = (ms: number) =>
	String(new Date(ms + 9 * 3_600_000).getUTCFullYear());

/**
 * The material document of a conversation as it stands (the ContextWindow layout specification, section 4): the
 * same function renders it for the conversation's generation and for the background calls that share its prefix.
 */
export function conversationDocumentInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	input: { window: WindowSnapshot | null; profileLimit: number; nowMs: number },
): {
	document: ContextDocument;
	refs: DocumentRefs;
	todos: TodoItem[];
	logged: ConversationEvent[];
	adopted: ReturnType<
		NonNullable<DialogueDeps["goals"]>["adoptedForContextInTransaction"]
	>;
} {
	const events = deps.continuity.events;
	const adopted = deps.goals?.adoptedForContextInTransaction(tx) ?? [];
	const logged = events.logInTransaction(tx, conversationId);
	const todos = deps.work?.todosInTransaction(tx, conversationId) ?? [];
	const refs: DocumentRefs = deps.work?.refsInTransaction(
		tx,
		conversationId,
	) ?? { todo: () => null, confirmation: () => null, resource: () => null };
	const document = renderDocument(
		{
			profile: input.window?.profile.items ?? [],
			episode: events.episodeInTransaction(tx, conversationId),
			log: logged,
			state: {
				todos,
				resources: resourceLinesInTransaction(
					deps,
					tx,
					conversationId,
					refs,
					tokyoYear(input.nowMs),
				),
				pendingConfirmation:
					deps.work?.pendingConfirmationsInTransaction(tx, conversationId) ??
					[],
				retained: (
					deps.work?.retainedInTransaction(tx, conversationId) ?? []
				).map((entry) => ({ id: entry.card.id, summary: entry.summary })),
				notes: deps.continuity.snapshotInTransaction(tx, conversationId).items,
				goals: adopted.map((goal) => ({
					id: goal.goalId,
					text: goal.desiredState,
				})),
				newMemories: input.window?.newMemories ?? [],
			},
		},
		{ profileLimit: input.profileLimit, refs, year: tokyoYear(input.nowMs) },
	);
	return { document, refs, todos, logged, adopted };
}

/**
 * The prefix a background call on the conversation reads (section 8.2): the conversation's system part, tool
 * definitions and document, byte for byte what its next generation sends while nothing changes in between, so the
 * call reads them from the cache of the conversation's connection. Only the last message (the task) is its own.
 * null when memory is unavailable (the conversation itself would not run then).
 */
export function conversationPrefixInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	nowMs: number,
): {
	messages: Array<{ role: "system" | "user"; content: string }>;
	tools: NativeTool[];
} | null {
	let window: WindowSnapshot | null = null;
	try {
		window = deps.memory?.storedWindowInTransaction(tx, conversationId) ?? null;
	} catch {
		return null;
	}
	const system = conversationSystem(deps, tx);
	const { document } = conversationDocumentInTransaction(
		deps,
		tx,
		conversationId,
		{ window, profileLimit: profileLimitOf(deps, system), nowMs },
	);
	return {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: document.text },
		],
		tools: generationTools,
	};
}

/** The dialogue service's part for the background calls on a conversation's prompt (steward, agency, prewarm). */
export function conversationPrefixPort(
	deps: DialogueDeps,
	clock: () => string,
) {
	return {
		/** The conversation the user talked in last (the newest run's). */
		latestConversationIdInTransaction: latestConversationId,
		/**
		 * The prefix a background call on the conversation shares with its generations (system, tool definitions,
		 * document; the ContextWindow layout specification, section 8.2). null when memory is unavailable.
		 */
		conversationPrefixInTransaction: (db: Database, conversationId: string) =>
			conversationPrefixInTransaction(
				deps,
				db,
				conversationId,
				Date.parse(clock()),
			),
	};
}
