import { createAlwaysOnHost } from "./always-on-host";
import { agendaSettingsKey } from "./always-on-settings";
import { agencyReplyParts } from "./system-context";
import { agendaReady } from "./always-on-scope";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import type { AgencyHostDeps } from "./host-types";
import type {
	AgencyActivity,
	AgencyThought,
} from "../../domains/dialogue/contracts/agency-status";

type Host = ReturnType<typeof createAlwaysOnHost>;

/**
 * The always-on host of the server. The host takes what it reads of the settings when it is made (the agent's voice,
 * its interval, its connection), so a saved change of one of them drains the host and makes the next one; a change of
 * any other setting leaves it running (`agendaSettingsKey` names what it reads).
 */
export function createRebuildingAgencyHost(
	deps: AgencyHostDeps,
	create: (deps: AgencyHostDeps) => Host = createAlwaysOnHost,
) {
	const key = () => agendaSettingsKey(deps.settings.get());
	let current = create(deps);
	let ownerKey = key(),
		started = false,
		closed = false;
	let unsubscribe: (() => void) | undefined;
	let changing = Promise.resolve();
	const change = () => {
		changing = changing
			.then(async () => {
				if (closed || key() === ownerKey) return;
				await current.close();
				const nextKey = key();
				current = create(deps);
				await current.recover();
				ownerKey = nextKey;
				if (started && !closed) current.start();
			})
			.catch((error) =>
				getLogger("agency").warn("agency.rebuild_failed", {
					reason: toErrorCode(error, "rebuild_failed"),
				}),
			);
	};
	return {
		recover: () => current.recover(),
		start() {
			if (started || closed) return;
			started = true;
			current.start();
			unsubscribe = deps.settings.onChange(change);
		},
		async close() {
			if (closed) return;
			closed = true;
			unsubscribe?.();
			await changing;
			await current.close();
		},
		conversationAgent: {
			system: () =>
				agencyReplyParts(deps.settings.get().agency, agendaReady(deps)),
			handsWork: () => current.conversationAgent.handsWork?.() ?? false,
			respond: (
				...args: Parameters<typeof current.conversationAgent.respond>
			) => current.conversationAgent.respond(...args),
		},
		dialoguePort: {
			assign: (
				...args: Parameters<NonNullable<typeof current.dialoguePort.assign>>
			) =>
				current.dialoguePort.assign?.(...args) ?? {
					status: "refused" as const,
					code: "agency_unavailable",
				},
			isCurrentInputInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.isCurrentInputInTransaction>
				>
			) => current.dialoguePort.isCurrentInputInTransaction!(...args),
			inputForMessageInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.inputForMessageInTransaction>
				>
			) => current.dialoguePort.inputForMessageInTransaction!(...args),
			inputForContextInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.inputForContextInTransaction>
				>
			) => current.dialoguePort.inputForContextInTransaction!(...args),
			stateForContextInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.stateForContextInTransaction>
				>
			) => current.dialoguePort.stateForContextInTransaction!(...args),
			steeredInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.steeredInTransaction>
				>
			) => current.dialoguePort.steeredInTransaction?.(...args) ?? [],
			servesRepliesInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.servesRepliesInTransaction>
				>
			) => current.dialoguePort.servesRepliesInTransaction?.(...args) ?? false,
			replyInputInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.replyInputInTransaction>
				>
			) => current.dialoguePort.replyInputInTransaction?.(...args) ?? null,
			goalSlotsInTransaction: (
				...args: Parameters<
					NonNullable<typeof current.dialoguePort.goalSlotsInTransaction>
				>
			) => current.dialoguePort.goalSlotsInTransaction?.(...args) ?? [],
			memoryExcludedInTransaction: (
				...args: Parameters<
					typeof current.dialoguePort.memoryExcludedInTransaction
				>
			) => current.dialoguePort.memoryExcludedInTransaction(...args),
		},
		/** The port for a target named in words (see `always-on-target.ts`). */
		memoryTargets: {
			requestInTransaction: (
				...args: Parameters<Host["memoryTargets"]["requestInTransaction"]>
			) => current.memoryTargets.requestInTransaction(...args),
		},
		forgetInTransaction: (
			db: Parameters<Host["forgetInTransaction"]>[0],
			purge: Parameters<Host["forgetInTransaction"]>[1],
		) => current.forgetInTransaction(db, purge),
		planForgetInTransaction: (
			db: Parameters<Host["planForgetInTransaction"]>[0],
			input: Parameters<Host["planForgetInTransaction"]>[1],
		) => current.planForgetInTransaction(db, input),
		invalidateTopics: () => current.invalidateTopics(),
		attend: (id: string, report?: AgencyActivity) => current.attend(id, report),
		status: (id: string) => current.status(id),
		/** What the agent of the conversation thought lately (display only). */
		thoughts: (id: string): AgencyThought[] => current.thoughts(id),
		inspect: (id: string) => current.inspect(id),
	};
}
