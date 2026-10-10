import {
	getIntake,
	listOpenIntakes,
	setBlockedReason,
	type IntakeRow,
} from "../repository/lifecycle";
import { WorldJournalCorruptError } from "./world-journal";
import type {
	ForgetRequest,
	ForgetReport,
	ForgetRefusal,
} from "./lifecycle-types";
import { StepBlocked, transientReason } from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";
import { createMemorySteps } from "./lifecycle-forget-memory";
import { createWorldSteps } from "./lifecycle-forget-steps";

export function createForgetOps(ctx: LifecycleCtx) {
	const { options, store, now, hook, withLock, acceptInWriter, report } = ctx;
	const { journalStep, worldStep } = createWorldSteps(ctx);
	const { syncConfirmations, memoryStep, reopenStep } = createMemorySteps(ctx);

	// --- driver -------------------------------------------------------------------

	function advance(forgetId: string): Promise<ForgetReport> {
		return withLock(forgetId, async () => {
			let world: ForgetReport["world"] = null;
			let externals: ForgetReport["externals"] = null;
			let blocked: string | null = null;
			for (let guard = 0; guard < 16; guard++) {
				const intake = store.read((db) => getIntake(db, forgetId));
				if (!intake) throw new Error("world_forget_unknown");
				if (intake.state === "complete") break;
				try {
					if (intake.state === "pending") await journalStep(intake);
					else if (intake.state === "journaled") {
						const out = await worldStep(intake);
						world = out.progress ?? world;
						if (out.blocked) {
							blocked = out.blocked;
							break;
						}
					} else if (intake.state === "world_applied") {
						hook("world_applied", forgetId);
						const out = await memoryStep(intake);
						externals = out.externals ?? externals;
						if (out.blocked) throw new StepBlocked(out.blocked);
					} else {
						const reason = await reopenStep(intake);
						if (reason) {
							blocked = reason;
							break;
						}
						hook("complete", forgetId);
					}
				} catch (error) {
					const reason = transientReason(error);
					if (reason === null) throw error;
					blocked = reason;
					if (error instanceof WorldJournalCorruptError)
						options.gate?.close("JOURNAL_CORRUPT");
					try {
						await store.write((db) =>
							setBlockedReason(db, forgetId, reason, now()),
						);
					} catch {
						/* reported through the return value below */
					}
					break;
				}
			}
			return report(forgetId, { blocked, world, externals });
		});
	}

	// --- public: forget -----------------------------------------------------------

	async function acceptForget(
		request: ForgetRequest,
		settings: { advance?: boolean } = {},
	): Promise<ForgetReport | ForgetRefusal> {
		const accepted = await store.write((db) => acceptInWriter(db, request));
		if ("status" in accepted) return accepted;
		hook("accepted", accepted.forgetId);
		if (settings.advance === false) return report(accepted.forgetId);
		return advance(accepted.forgetId);
	}

	async function resumeForgets(
		filter?: (row: IntakeRow) => boolean,
	): Promise<ForgetReport[]> {
		const open = store.read((db) => listOpenIntakes(db));
		const reports: ForgetReport[] = [];
		for (const row of open) {
			if (filter && !filter(row)) continue;
			reports.push(await advance(row.forgetId));
		}
		return reports;
	}

	return { advance, acceptForget, resumeForgets, syncConfirmations };
}
export type ForgetOps = ReturnType<typeof createForgetOps>;
