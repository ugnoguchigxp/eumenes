import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Purpose } from "../../domains/settings";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";

export const INFERENCE_ADAPTER_REF = "adapter:inference@1";
const PROBES = "query:inference.probes@1";
const PROBE_TARGETS = "query:inference.probe-targets@1";
const LARM = "query:inference.larm@1";
const LAST_USAGE = "query:inference.last-usage@1";

const targetRef = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const probeStart = z.strictObject({ target: targetRef });
const probeCancel = z.strictObject({ id: targetRef });

type ProbeRow = {
	id: string;
	target: string;
	status: string;
	error: string | null;
	revision: number;
	created: number;
};
type UsageRow = {
	purpose: Purpose;
	source: string;
	model: string;
	accepted: number;
};

/** What the inference adapter reads and does; each is the inference domain's public operation. */
export type InferenceAdapterPorts = {
	probes(): unknown;
	getProbe(id: string): unknown;
	inspect(): unknown;
	usage(): unknown;
	startProbeInTransaction(
		db: Database,
		target: string,
	): { id: string; launch(): void };
	/** Marks a running probe as cancelling (throws probe_not_found / probe_not_running). */
	cancelProbeInTransaction(db: Database, id: string): void;
	cancelProbe(id: string): void;
};
/** The settings the targets are listed from (resources of the saved document). */
export type InferenceSettingsPort = {
	inTransaction(db: Database): {
		resources: Array<{
			id: string;
			connectionId: string;
			purpose: Purpose;
			model: string;
		}>;
		connections: Array<{ id: string; name: string; enabled: boolean }>;
	};
};

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the inference adapter offers, without the domain (bundle checks, evaluation). */
export const describeInferenceAdapter = () => ({
	owner: "inference",
	operations: new Map([
		[
			"inference.probe-start",
			{
				inputSchemaRef: "schema:inference-probe-start@1",
				effect: "write" as const,
			},
		],
		[
			"inference.probe-cancel",
			{
				inputSchemaRef: "schema:inference-probe-cancel@1",
				effect: "write" as const,
			},
		],
	]),
	queries: new Set([PROBES, PROBE_TARGETS, LARM, LAST_USAGE]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:inference@1",
});

/**
 * The typed inference adapter: connection checks (probes), the LARM details and the latest
 * accepted use per purpose. A probe is registered in the caller's writer transaction and runs
 * after the commit. Conversations cannot start or cancel probes.
 */
export function createInferenceAdapter(
	inference: InferenceAdapterPorts,
	settings: InferenceSettingsPort,
): DomainAdapter {
	// Work to start once the registering transaction has committed.
	const launches: Array<() => void> = [];
	const cancels: string[] = [];
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
		resultRef?: AdapterResult["resultRefs"][number],
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "inference",
				operationId: requestId,
				digest: sha256(receipt),
			},
			resultRefs: resultRef ? [resultRef] : [],
			replay: false,
		};
	}
	function targets(tx: Database) {
		const saved = settings.inTransaction(tx);
		return [
			{ id: "larm", label: "LARM", purpose: null, enabled: true },
			...saved.resources.map((r) => ({
				id: r.id,
				label: `${saved.connections.find((c) => c.id === r.connectionId)?.name ?? "登録モデル"} / ${r.model}`,
				purpose: r.purpose,
				enabled:
					saved.connections.find((c) => c.id === r.connectionId)?.enabled ??
					false,
			})),
		];
	}
	return {
		ref: INFERENCE_ADAPTER_REF,
		describe: describeInferenceAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request) {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			if (request.operationName === "inference.probe-start") {
				const input = probeStart.safeParse(request.input);
				if (!input.success) throw new Error("invalid_input");
				const started = inference.startProbeInTransaction(
					tx,
					input.data.target,
				);
				launches.push(started.launch);
				return done(
					{ version: 1, kind: "probe-started", id: started.id },
					request.requestId,
					{
						owner: "inference",
						kind: "probe",
						id: started.id,
						schemaRef: "domain:inference.probe@1",
					},
				);
			}
			if (request.operationName === "inference.probe-cancel") {
				const input = probeCancel.safeParse(request.input);
				if (!input.success) throw new Error("invalid_input");
				inference.cancelProbeInTransaction(tx, input.data.id);
				cancels.push(input.data.id);
				return done(
					{ version: 1, kind: "probe-cancelled", id: input.data.id },
					request.requestId,
					{
						owner: "inference",
						kind: "probe",
						id: input.data.id,
						schemaRef: "domain:inference.probe@1",
					},
				);
			}
			throw new Error("capability_unavailable");
		},
		// A probe's state is the probes list: nothing else to reload.
		readInTransaction: () => null,
		sourceInTransaction(tx, query, target) {
			if (query === PROBES) {
				// Each probe names its target the way the target list does.
				const names = new Map(targets(tx).map((t) => [t.id, t.label]));
				const probes = (inference.probes() as ProbeRow[]).map((p) => ({
					...p,
					label: names.get(p.target) ?? "削除されたモデル",
				}));
				if (target === undefined) return { revision: 0, data: { probes } };
				const one = probes.find((p) => p.id === target);
				return one ? { revision: 0, data: { probes: [one] } } : null;
			}
			if (query === PROBE_TARGETS) {
				const all = targets(tx);
				if (target === undefined)
					return { revision: 0, data: { targets: all } };
				const one = all.find((t) => t.id === target);
				return one ? { revision: 0, data: { targets: [one] } } : null;
			}
			if (query === LARM) return { revision: 0, data: inference.inspect() };
			if (query === LAST_USAGE) {
				const rows = inference.usage() as UsageRow[];
				const last = (purpose: Purpose) => {
					const row = rows.find((u) => u.purpose === purpose && u.accepted);
					return row ? { source: row.source, model: row.model } : null;
				};
				return {
					revision: 0,
					data: { llm: last("llm"), asr: last("asr"), tts: last("tts") },
				};
			}
			return null;
		},
		targetInput: (query, ref) =>
			query === PROBE_TARGETS
				? { target: ref }
				: query === PROBES
					? { id: ref }
					: {},
		afterCommit() {
			const start = launches.splice(0);
			// Only a cancel that committed left its mark; a rolled-back one aborts nothing.
			for (const id of cancels.splice(0))
				if (
					(inference.getProbe(id) as ProbeRow | null)?.status === "cancelling"
				)
					inference.cancelProbe(id);
			for (const launch of start) launch();
		},
	};
}
