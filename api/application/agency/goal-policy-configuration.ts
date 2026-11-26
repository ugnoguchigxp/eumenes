import type { Database } from "bun:sqlite";
import type {
	GoalProgress,
	GoalReadPolicyGrant,
	GoalStore,
} from "eumenes-agency/agenda/runtime";
import type { Settings } from "../../domains/settings";
import type { SupervisionTarget } from "../../domains/development-supervision";
import type { createGoalWebNote } from "./goal-web-note";
import { goalAccess, goalDigest } from "./goal-progress-context";
import type { GoalWorkspaceRegistry } from "./goal-workspaces";

export function createGoalPolicyConfiguration(ports: {
	goals: GoalStore;
	workspaces: GoalWorkspaceRegistry;
	binding(db: Database): SupervisionTarget | null;
	available(db: Database, workspaceRef: string): boolean;
	ordinary?: {
		policy(db: Database, row: GoalProgress): GoalReadPolicyGrant | null;
		available(): boolean;
	};
	inferenceConfiguration?(db: Database): unknown;
	webPolicy?: ReturnType<typeof createGoalWebNote>["readPolicy"];
}) {
	return (db: Database, row: GoalProgress) => {
		const binding = ports.binding(db);
		const local = binding
			? ports.workspaces
					.readPolicies(binding.toolchainRevisionId)
					.map((entry) => {
						const { workspaceRef } = entry.scope;
						const available = ports.available(db, workspaceRef);
						const policy = {
							...entry,
							toolchainRevisionId: binding.toolchainRevisionId,
							policyKey: `workspace:${workspaceRef}`,
							policyGeneration: goalDigest([
								{
									...entry,
									scope: {
										...entry.scope,
										readablePaths: [
											...new Set(entry.scope.readablePaths),
										].sort(),
										checks: [...entry.scope.checks].sort((a, b) =>
											a.ref.localeCompare(b.ref),
										),
									},
								},
								binding.bindingRevisionId,
							]),
						};
						return { policy, available };
					})
			: [];
		const ordinary = ports.ordinary?.policy(db, row);
		const web = ports.webPolicy?.(db);
		const policies: GoalReadPolicyGrant[] = local.map(({ policy }) => policy);
		if (ordinary) policies.push(ordinary);
		if (web)
			policies.push({
				...web,
				policyKey: "public-web",
				policyGeneration: goalDigest(web),
			});
		const digest = goalDigest([
			policies
				.map(({ policyKey, policyGeneration }) => [policyKey, policyGeneration])
				.sort(),
			local
				.map(({ policy, available }) => [policy.policyKey, available])
				.sort(),
			...(ordinary ? [ports.ordinary?.available()] : []),
			ports.inferenceConfiguration?.(db),
		]);
		const result = ports.goals.reconcileReadPoliciesInTransaction(
			db,
			goalAccess(row),
			row,
			{
				digest,
				policies,
				summary: ordinary
					? "ホストが通常の Claude Code 作業先の構成を照合しました。利用者への作業先・ファイル・通常検査の確認は不要です。"
					: "ホストが登録作業先、読取・検査の許可、実行先の現在の構成を照合しました。提示された参照と検査から次の手を選べます。",
			},
		);
		return result.status === "stale" ? row : result.progress;
	};
}

export function goalInferenceConfiguration(configured: Settings) {
	const route = configured.routes.llm;
	const resources = [
		configured.agency.thinkResourceId,
		route.fallbackId,
	].flatMap((id) => configured.resources.filter((item) => item.id === id));
	return [
		route,
		configured.general.reasoningEffort,
		resources,
		configured.connections.filter((connection) =>
			resources.some((resource) => resource.connectionId === connection.id),
		),
	];
}
