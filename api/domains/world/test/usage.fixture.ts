import type { SourceRef } from "eumenes-memory";
import { validateWorldUsage } from "eumenes-world-model/sqlite";
import type { WorldReadRequest } from "../contracts";
import {
	createWorldService,
	type WorldServiceOptions,
} from "../service/world-service";
import { readHostState, readForgetEpoch } from "../repository";
import { isMemoryStateItem, resolveSources } from "../service/inputs";

/** Legacy Slice receipt checks remain package integration tests, outside the production API. */
export function createWorldFixture(options: WorldServiceOptions) {
	const world = createWorldService(options);
	const adapters = new Map(options.sources.map((s) => [s.namespace, s]));
	return {
		...world,
		validateUsage(
			receipt: unknown,
			request: Pick<WorldReadRequest, "access" | "scope">,
		) {
			return options.store.write((db) => {
				if (options.gate && !options.gate.isOpen())
					return {
						status: "blocked" as const,
						reasonCode: "WORLD_RECOVERY_REQUIRED",
					};
				if (!readHostState(db).enabled)
					return { status: "blocked" as const, reasonCode: "WORLD_DISABLED" };
				const access = world.accessInTransaction(db, request);
				const value =
					receipt !== null &&
					typeof receipt === "object" &&
					!Array.isArray(receipt)
						? (receipt as { sourceVersions?: unknown }).sourceVersions
						: undefined;
				const refs = Array.isArray(value)
					? value.filter(
							(ref): ref is SourceRef =>
								ref !== null &&
								typeof ref === "object" &&
								!Array.isArray(ref) &&
								["namespace", "kind", "id", "revision", "digest"].every(
									(key) => typeof ref[key] === "string",
								),
						)
					: [];
				const resolved = resolveSources(
					db,
					adapters,
					access,
					request.scope,
					refs,
					"lenient",
					options.isStateItem ?? isMemoryStateItem,
				);
				return validateWorldUsage(db, receipt, {
					contractVersion: 1,
					access,
					scope: request.scope,
					hostChecks: {
						gate: "open",
						sourceSnapshot: { states: resolved.ok ? resolved.states : [] },
						forgetEpoch: readForgetEpoch(
							db,
							request.scope.principal,
							request.scope.scopeKey,
						),
						restoreEpoch: readHostState(db).restoreEpoch,
						policyRevision: access.policyRevision,
					},
				});
			});
		},
	};
}
