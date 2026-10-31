import { createHash } from "node:crypto";
import type { DomainAdapter, AdapterResult } from "../../domains/tool-runtime";
import { createUsage } from "../../domains/usage";
import {
	liveUsageInTransaction,
	liveUsageModelsInTransaction,
	activeLiveUsageInTransaction,
} from "../../domains/live-voice";
import { codexUsageInTransaction } from "../../domains/inference";
import type { SettingsService } from "../../domains/settings";

export const USAGE_ADAPTER_REF = "adapter:usage@1";
export const describeUsageAdapter = () => ({
	owner: "usage",
	operations: new Map([
		[
			"usage.rate-save",
			{ inputSchemaRef: "schema:usage-rate@1", effect: "write" as const },
		],
	]),
	queries: new Set(["query:usage.dashboard@1"]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:usage@1",
});
export function createUsageAdapter(
	settings: Pick<SettingsService, "inTransaction">,
): DomainAdapter {
	const usage = createUsage({
		live: liveUsageInTransaction,
		activeLive: activeLiveUsageInTransaction,
		codex: codexUsageInTransaction,
		choices(db) {
			const doc = settings.inTransaction(db);
			const resource = doc.resources.find(
				(r) => r.id === doc.routes.llm.fallbackId,
			);
			const connection = doc.connections.find(
				(c) => c.id === resource?.connectionId,
			);
			return {
				models: [
					...doc.resources
						.filter((r) =>
							doc.connections.some(
								(c) => c.id === r.connectionId && c.kind === "codex-sdk",
							),
						)
						.map((r) => r.model),
					...(doc.live.model ? [doc.live.model] : []),
				],
				liveModels: [
					...liveUsageModelsInTransaction(db),
					...(doc.live.model ? [doc.live.model] : []),
				],
				currentCodexModel:
					connection?.kind === "codex-sdk" ? (resource?.model ?? "") : "",
			};
		},
	});
	function result(receipt: { id: string }, replay: boolean): AdapterResult {
		return {
			receipt,
			replay,
			resultRefs: [],
			receiptRef: {
				owner: "usage",
				operationId: receipt.id,
				digest: createHash("sha256")
					.update(JSON.stringify(receipt))
					.digest("hex"),
			},
		};
	}
	return {
		ref: USAGE_ADAPTER_REF,
		describe: describeUsageAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({}),
		invokeInTransaction(db, request) {
			if (
				request.origin.kind !== "ui" ||
				request.operationName !== "usage.rate-save"
			)
				throw new Error("capability_unavailable");
			const saved = usage.saveRateInTransaction(
				db,
				request.requestId,
				request.input,
			);
			return result(saved.receipt, saved.replay);
		},
		readInTransaction(db, id) {
			const receipt = usage.readInTransaction(db, id);
			return receipt ? result(receipt, true) : null;
		},
		sourceInTransaction(db, query, _target, params) {
			if (query !== "query:usage.dashboard@1") return null;
			const data = usage.dashboardInTransaction(db, params);
			return { revision: data.revision, data };
		},
		targetInput: () => ({}),
	};
}
