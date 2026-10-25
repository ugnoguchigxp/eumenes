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
	return new Set(
		readyCatalog(
			deps,
			db,
			() =>
				!!deps.delegation &&
				deps.delegation.prepareInTransaction(db, run).available !== false,
		).map((entry) => entry.id),
	);
}

/**
 * The titles of the toolchains this host can run, in a fixed order: the system part names them so the model knows
 * what it can hand over before it searches (ContextWindow specification, section 6.1). Delegation counts while it
 * is configured; whether one run may delegate is the search's check.
 */
export function toolchainTitlesInTransaction(
	deps: DialogueDeps,
	db: Database,
): string[] {
	const titles = readyCatalog(deps, db, () => !!deps.delegation)
		.sort((a, b) => a.id.localeCompare(b.id))
		.flatMap(
			(entry) =>
				deps.toolchains?.cardInTransaction(db, entry.revisionId)?.title ?? [],
		);
	return [...new Set(titles)];
}

function readyCatalog(deps: DialogueDeps, db: Database, dots: () => boolean) {
	const { agents, toolchains } = deps;
	if (!toolchains) return [];
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
								? dots()
								: false;
	return toolchains
		.catalogInTransaction(db)
		.filter(({ runtime }) =>
			runtime.binding ? runtime.binding.available : ready(runtime.requires),
		);
}
