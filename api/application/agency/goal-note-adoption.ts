import type { GoalProgress, GoalStore } from "eumenes-agency/agenda/runtime";
import type { AgencyHostDeps } from "./host-types";
import { goalAccess, goalDigest } from "./goal-progress-context";
import type { createGoalProgress, GoalProgressPorts } from "./goal-progress";
import { recordPrefix } from "./input";

function matchesSubscription(
	row: GoalProgress,
	note: Parameters<
		NonNullable<AgencyHostDeps["goalResearchNoteInTransaction"]>
	>[1],
) {
	const refs = new Set(note.refs.map((ref) => ref.replace(/:c\d+$/u, "")));
	const explicit = row.state.watch?.subjectRef;
	if (explicit) return explicit === note.id || refs.has(explicit);
	if (refs.has("goal:" + row.goalId)) return true;
	return row.state.evidence.some(({ sources }) =>
		sources?.some((source) => {
			if (!source.startsWith(recordPrefix)) return false;
			try {
				const value: unknown = JSON.parse(source.slice(recordPrefix.length));
				return (
					Array.isArray(value) &&
					value[0] === "plan" &&
					typeof value[1] === "string" &&
					refs.has("plan:" + value[1])
				);
			} catch {
				return false;
			}
		}),
	);
}

export function createGoalNoteAdopter(
	goals: GoalStore,
	progress: Pick<
		ReturnType<typeof createGoalProgress>,
		"notifyDocumentInTransaction"
	>,
	sourcesCurrent: GoalProgressPorts["sourcesCurrent"],
): NonNullable<AgencyHostDeps["goalResearchNoteInTransaction"]> {
	return (db, note) => {
		const digest = goalDigest([
			note.id,
			note.title,
			note.markdown,
			note.sources,
		]);
		const evidence = {
			ref: note.id,
			version: digest,
			digest,
			summary: note.summary || note.title,
			sources: note.sources,
		};
		for (const row of goals.progressRowsInTransaction(db)) {
			if (
				row.deliveryConversationId !== note.conversationId ||
				!matchesSubscription(row, note)
			)
				continue;
			const watch = row.state.watch;
			const producer =
				watch?.producer === "goal-configuration" ? watch.producer : "markdown";
			progress.notifyDocumentInTransaction(
				db,
				row,
				goalAccess(row),
				{
					producer,
					ref: watch?.subjectRef ?? note.id,
					version: digest,
					digest,
					evidence: [evidence],
				},
				(tx, live) =>
					live.deliveryConversationId === note.conversationId &&
					sourcesCurrent(tx, live, note.sources),
				true,
			);
		}
	};
}
