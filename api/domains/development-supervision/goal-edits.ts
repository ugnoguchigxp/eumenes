import type { Database } from "bun:sqlite";
import { hash } from "../capabilities";
import type {
	SupervisionChildEvidence,
	SupervisionScope,
	SupervisionWorkspaceEvidence,
} from "./contracts";
import { goalParents, grantOf } from "./repository";
import type { Grant, Parent, Task } from "./state";

const pathsOf = ({ readablePaths, writablePaths }: SupervisionScope) => [
	[...new Set(readablePaths)].sort(),
	[...new Set(writablePaths)].sort(),
];

export function earlierGoalEdit(
	db: Database,
	parent: Parent,
	scope: SupervisionScope,
) {
	const { source } = parent;
	if (!parent.goalScope || source.origin !== "goal" || scope.mode !== "edit")
		return undefined;
	for (const previous of goalParents(db, source.goalId, scope.workspaceRef)) {
		const old = previous.source;
		if (
			previous.id === parent.id ||
			previous.phase !== "finished" ||
			old.origin !== "goal" ||
			old.principal !== source.principal ||
			old.scopeKey !== source.scopeKey ||
			old.goalRevision !== source.goalRevision ||
			old.permitId !== source.permitId ||
			old.permitRevision !== source.permitRevision ||
			previous.workspace.rootPath !== parent.workspace.rootPath
		)
			continue;
		for (const task of previous.tasks) {
			const owned = task.ownedEdit;
			const grant = task.grantRef && grantOf(db, task.grantRef);
			if (
				owned &&
				grant &&
				grant.released &&
				grant.scope.targetRevision === scope.targetRevision &&
				owned.after.targetRevision === scope.targetRevision &&
				hash(pathsOf(grant.scope)) === hash(pathsOf(scope)) &&
				owned.paths.every((path) => scope.writablePaths.includes(path))
			)
				return owned;
		}
	}
	return undefined;
}

export function rememberGoalEdit(
	parent: Parent,
	task: Task,
	grant: Grant,
	observed: SupervisionWorkspaceEvidence,
	evidence: readonly SupervisionChildEvidence[],
) {
	const latest = evidence.findLast(({ kind }) => kind === "edit");
	const paths = [
		...new Set(
			evidence.flatMap(({ kind, path }) =>
				kind === "edit" && path ? [path] : [],
			),
		),
	];
	const before = task.before;
	if (
		parent.goalScope &&
		grant.released &&
		grant.scope.mode === "edit" &&
		before?.preserved &&
		before.snapshotId &&
		observed.preserved &&
		before.targetRevision === observed.targetRevision &&
		before.snapshotId === observed.snapshotId &&
		before.inputDigest !== observed.inputDigest &&
		latest?.inputDigest === observed.inputDigest &&
		paths.length &&
		paths.every((path) => grant.scope.writablePaths.includes(path))
	)
		task.ownedEdit = { before, after: observed, paths };
}
