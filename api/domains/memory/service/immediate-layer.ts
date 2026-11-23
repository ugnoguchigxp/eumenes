import type { Database } from "bun:sqlite";
import type { AccessContext } from "eumenes-memory";
import type {
	ExcludeForForgetInput,
	ExcludeForForgetOutcome,
} from "../contracts/immediate";
import type { ForgetInput, ForgetOutcome, ForgetPurge } from "../contracts";
import { purgeMarks } from "../repository";
import { purgeExplicitRequests, purgeShortRefs } from "../repository/immediate";
import { createEvidence } from "./curation-evidence";
import type { CurationDeps } from "./curation-shared";
import { createExclusion } from "./exclusion";
import { createExplicitOps } from "./explicit";
import type { createForget } from "./forget";
import type { ContextWindowStore } from "./context-window";
import { createShortRefs } from "./short-refs";
import { createSuppression } from "./suppression";
import { createWithdraw } from "./withdraw";
import { createWithheld } from "./withheld";
import type { ConversationService } from "../../conversation";

/**
 * The immediate layer of the memory redesign (sections 5 and 7.2), as the memory service offers it. Every operation
 * runs in the caller's writer transaction (the run's adoption), carries the run's id (`sourceRunId`: the run's own
 * change never expires it), and answers with a result that says why nothing was done instead of throwing.
 */
export function createImmediateLayer(
	deps: CurationDeps & {
		conversation: ConversationService;
		windows: ContextWindowStore;
		journalPath: string;
		access: (db: Database, purpose: string) => AccessContext;
		forgetter: ReturnType<typeof createForget>;
		health: { healthy: boolean };
		/** The blocked ones among the messages (the database's blocks and the journal's). */
		blockedMessages: (
			db: Database,
			messageIds: Iterable<string>,
		) => ReadonlySet<string>;
		/** Completes the journals (the recovery); a journal line written ahead of a failed transaction is finished by it. */
		recover: () => Promise<unknown>;
	},
) {
	const withheld = createWithheld(deps);
	// Plans, ledger entries and tendencies resting on what a forget in flight excluded are left out meanwhile.
	deps.continuity.setEvidenceExclusion(withheld.sources);
	deps.windows.setWithheldTendencies(withheld.tendencies);
	const shortRefs = createShortRefs();
	const shared = {
		...deps,
		shortRefs,
		evidence: createEvidence(deps),
	};
	const explicit = createExplicitOps(shared);
	const suppression = createSuppression(shared);
	const exclusion = createExclusion(shared);
	return {
		/** A forget removes the requests and short references that name its items. */
		purgeInTransaction(db: Database, purge: ForgetPurge) {
			purgeExplicitRequests(db, purge.itemIds);
			purgeShortRefs(db, purge.itemIds);
			purgeMarks(db, purge.itemIds);
		},
		operations: {
			/** "Remember this" and what the user stated of themselves: saved `user_confirmed` when the quote stands in their message. */
			rememberExplicitInTransaction: explicit.remember,
			/** A correction of the version the user named: the old version is replaced (`correction`), the new one saved. */
			correctExplicitInTransaction: explicit.correct,
			/** Takes back an applied "remember" or correction of the conversation (a forget is never taken back). */
			withdrawExplicitInTransaction: createWithdraw(shared).withdraw,
			/**
			 * The immediate stage of a forget: every version of the facts named (and their candidates) is excluded, with a
			 * line in the forget journal, until the closure delete (`forgetInTransaction`) removes them. A journal line
			 * written before the caller's transaction fails is completed by the recovery, as for `forgetInTransaction`.
			 */
			excludeForForgetInTransaction(
				db: Database,
				input: ExcludeForForgetInput,
			): ExcludeForForgetOutcome {
				let journaled = false;
				try {
					const outcome = exclusion.exclude(db, input, () => {
						journaled = true;
					});
					if (journaled) void deps.recover();
					return outcome;
				} catch (error) {
					if (!journaled) throw error;
					deps.health.healthy = false;
					void deps.recover();
					throw new Error("memory_forget_incomplete");
				}
			},
			/**
			 * The closure delete after an exclusion: the same as `forgetInTransaction`, with no limit on the count of items.
			 * The limit belongs to the user's request (the exclusion takes at most five); what the exclusion found
			 * (every version, the merge lineage) is the closure's to delete, however many that is. Pass what the
			 * exclusion returned.
			 */
			closeExclusionInTransaction(
				db: Database,
				input: ForgetInput,
			): ForgetOutcome {
				let journaled = false;
				try {
					const outcome = deps.forgetter.forgetInTransaction(
						db,
						input,
						() => {
							journaled = true;
						},
						false,
					);
					void deps.recover();
					return outcome;
				} catch (error) {
					if (!journaled) throw error;
					deps.health.healthy = false;
					void deps.recover();
					throw new Error("memory_forget_incomplete");
				}
			},
			/** "Do not bring that up": marks a record's fact, or stores a topic word when no record stands for the topic. */
			suppressInTransaction: suppression.suppress,
			releaseSuppressionInTransaction: suppression.release,
			/** The topic words and the marked facts (read-only). */
			suppressionsInTransaction: suppression.list,
			/**
			 * The messages out of use: blocked ones, and those a record that is only excluded (its closure delete not run
			 * yet) stands on. One answer for the background pass, goals and the history.
			 */
			withheldMessagesInTransaction: withheld.messages,
			/** The short references (`m1`...) of a conversation's window. */
			shortRefs,
		},
	};
}
