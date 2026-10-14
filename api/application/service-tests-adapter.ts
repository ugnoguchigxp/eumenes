import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServiceRun, ServiceTarget } from "../domains/service-tests";
import {
	healthLabels,
	kindLabels,
	phaseLabels,
	testErrorLabel,
} from "../domains/service-tests/contracts";
import type { ServiceTests } from "../domains/service-tests";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const SERVICE_TESTS_ADAPTER_REF = "adapter:service-tests@1";
const CATALOG = "query:service-tests.catalog@1";
const STATUS = "query:service-tests.status@1";
const RUNS = "query:service-tests.runs@1";
const HEALTH = "query:service-tests.health@1";
const TARGETS = "query:service-tests.targets@1";

/** What the adapter drives: the domain's catalog and its transaction operations. */
export type ServiceTestsPorts = Pick<
	ServiceTests,
	| "catalog"
	| "refresh"
	| "runsInTransaction"
	| "startInTransaction"
	| "diagnoseInTransaction"
	| "cancelInTransaction"
	| "retryArtifactInTransaction"
>;

const START_SCHEMA = "schema:service-tests-start@1";
const RUN_SCHEMA = "schema:service-tests-run@1";
const startInput = z.strictObject({
	targetId: z.string().min(1).max(150),
	/** The catalog revision the person saw; absent for the free-form start. */
	revision: z.number().int().min(0).optional(),
	text: z.string().max(4096).optional(),
	comparison: z.string().max(4096).optional(),
	voice: z.string().max(128).optional(),
	width: z.number().int().min(100).max(1280).optional(),
	height: z.number().int().min(100).max(1280).optional(),
	format: z.enum(["png", "webp"]).optional(),
	seed: z.number().int().safe().optional(),
	durationSeconds: z.number().int().min(1).max(30).optional(),
	uploadId: z.string().uuid().optional(),
});
const runInput = z.strictObject({ runId: z.uuid() });
const emptyInput = z.strictObject({});

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the service-tests adapter offers, without a service (bundle checks, evaluation). */
export const describeServiceTestsAdapter = () => ({
	owner: "service-tests",
	operations: new Map(
		(
			[
				["service-tests.start", START_SCHEMA],
				["service-tests.refresh", "builtin:emptyInput"],
				["service-tests.diagnose", "builtin:emptyInput"],
				["service-tests.cancel", RUN_SCHEMA],
				["service-tests.retry-artifact", RUN_SCHEMA],
			] as const
		).map(([name, inputSchemaRef]) => [
			name,
			{ inputSchemaRef, effect: "write" as const },
		]),
	),
	queries: new Set([CATALOG, STATUS, RUNS, HEALTH, TARGETS]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:service-tests@1",
});

const sourceLabels = { larm: "LARM", cloud: "クラウド" } as const;
const sampleText: Record<ServiceTarget["kind"], string> = {
	llm: "こんにちは。自己紹介を一文でお願いします。",
	tts: "こんにちは。音声の確認です。",
	asr: "無音サンプル",
	embedding: "猫が窓辺で眠っています。",
	decision: "こんにちは。",
	image: "朝の光が入る静かな書斎。木の机と観葉植物。",
	music: "穏やかな朝に合う、ピアノの短いインストゥルメンタル。",
	unsupported: "",
};
const statusLabels: Record<ServiceRun["status"], string> = {
	running: "実行中",
	succeeded: "成功",
	failed: "失敗",
	cancelled: "中止",
	unknown: "結果不明",
	interrupted: "中断",
	"result-unavailable": "生成済み・結果取得に失敗",
};
function targetRow(target: ServiceTarget, revision: number) {
	return {
		id: target.id,
		name: target.name,
		model: target.model,
		sample: sampleText[target.kind],
		kind: kindLabels[target.kind],
		kindCode: target.kind,
		source: sourceLabels[target.source],
		sourceCode: target.source,
		primary: target.primary,
		onDemand: target.onDemand,
		start: target.onDemand ? "実行時に起動" : "常駐",
		testable: target.testable,
		state: target.testable
			? "試せます"
			: testErrorLabel(target.reason ?? "invalid_test_target"),
		revision,
	};
}

function runRow(run: ServiceRun) {
	return {
		id: run.id,
		targetId: run.targetId,
		kind: kindLabels[run.kind as keyof typeof kindLabels] ?? "Health確認",
		model: run.model || "全サービス",
		status: run.status,
		statusLabel: statusLabels[run.status],
		phase: phaseLabels[run.phase] ?? run.phase,
		created: run.created,
		ended: run.ended ?? null,
		error: run.error ? testErrorLabel(run.error) : "",
		text: run.text ?? "",
		progress: run.progress ?? null,
		revision: run.revision,
		actualModel: run.actualModel ?? "",
		previewAvailable: run.previewAvailable === true,
		// A same-origin path and type the screen fetches and previews (image or audio).
		preview:
			run.previewAvailable === true && run.mime
				? {
						path: `/api/service-tests/runs/${run.id}/artifact`,
						mime: run.mime,
					}
				: null,
		retryArtifact: run.retryArtifact === true,
	};
}

/**
 * The typed service-tests adapter: the catalog of testable services, test runs, Health
 * diagnosis, cancellation and result re-fetch. The domain keeps every rule (stale catalog,
 * one running test, request keys, previews); work that waits on the network starts only after
 * the writer transaction commits (`afterCommit`). Previews and audio uploads are not carried
 * here: they are binary and need their own view.
 */
export function createServiceTestsAdapter(
	service: ServiceTestsPorts,
): DomainAdapter {
	/**
	 * Effects of accepted operations, run once their transaction has committed. `afterCommit`
	 * cannot tell which write it follows, so an effect reports whether its row is committed
	 * yet; one that never is (an aborted write) is dropped after a while.
	 */
	const pending = new Map<string, { effect: () => boolean; at: number }>();
	let refreshState: "idle" | "running" | "failed" = "idle";
	let refreshError = "";
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
		runId: string,
		replay: boolean,
		effect?: () => boolean,
	): AdapterResult {
		if (effect) pending.set(requestId, { effect, at: Date.now() });
		return {
			receipt,
			receiptRef: {
				owner: "service-tests",
				operationId: requestId,
				digest: sha256(receipt),
			},
			resultRefs: [
				{
					owner: "service-tests",
					kind: "run",
					id: runId,
					schemaRef: "domain:service-tests.run@1",
				},
			],
			replay,
		};
	}
	const accepted = (
		kind: string,
		requestId: string,
		result: { run: ServiceRun; launch?: () => boolean },
	) =>
		done(
			{ version: 1, kind, runId: result.run.id },
			requestId,
			result.run.id,
			!result.launch,
			result.launch,
		);
	function startRun(tx: Database, requestId: string, raw: unknown) {
		const parsed = startInput.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_input");
		const { targetId, revision, ...rest } = parsed.data;
		return accepted(
			"start",
			requestId,
			service.startInTransaction(tx, {
				targetId,
				// The revision of a row the person acted on; a free-form start has none.
				revision,
				// The ledger's event id is the idempotency key: a resend never starts a second run.
				requestKey: requestId,
				input: rest,
			}),
		);
	}
	const runIdOf = (raw: unknown) => {
		const parsed = runInput.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_input");
		return parsed.data.runId;
	};
	function refreshCatalog(requestId: string): AdapterResult {
		return done(
			{ version: 1, kind: "refresh" },
			requestId,
			"catalog",
			false,
			() => {
				refreshState = "running";
				void service
					.refresh()
					.then(() => {
						refreshState = "idle";
						refreshError = "";
					})
					.catch((error) => {
						refreshState = "failed";
						refreshError = error instanceof Error ? error.message : "";
					});
				return true;
			},
		);
	}
	function status(runs: ServiceRun[]) {
		const catalog = service.catalog();
		const latest = runs.find(
			(r) => r.kind === "diagnostics" && r.status !== "running",
		);
		return [
			{
				id: "catalog",
				catalogRevision: catalog.revision,
				diagnosisRevision: latest?.revision ?? null,
				state: catalog.stale ? "更新が必要です" : "最新",
				discoveredAt: catalog.discoveredAt,
				targetCount: catalog.targets.length,
				errors: catalog.errors
					.slice(0, 3)
					.map((code) => testErrorLabel(code))
					.join(" / "),
				refresh:
					refreshState === "running"
						? "更新中"
						: refreshState === "failed"
							? testErrorLabel(refreshError)
							: "",
				// A running test, diagnosis or refresh: the screen re-reads while this is true.
				busy:
					refreshState === "running" ||
					runs.some((r) => r.status === "running"),
				control: !latest
					? "未確認"
					: latest.controlHealthy
						? "正常"
						: "確認できません",
			},
		];
	}
	return {
		ref: SERVICE_TESTS_ADAPTER_REF,
		describe: describeServiceTestsAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request): AdapterResult {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			const { requestId } = request;
			switch (request.operationName) {
				case "service-tests.start":
					return startRun(tx, requestId, request.input);
				case "service-tests.refresh":
					if (!emptyInput.safeParse(request.input).success)
						throw new Error("invalid_input");
					return refreshCatalog(requestId);
				case "service-tests.diagnose":
					if (!emptyInput.safeParse(request.input).success)
						throw new Error("invalid_input");
					return accepted(
						"diagnose",
						requestId,
						service.diagnoseInTransaction(tx, requestId),
					);
				case "service-tests.cancel": {
					const runId = runIdOf(request.input);
					const stop = service.cancelInTransaction(tx, runId);
					return done(
						{ version: 1, kind: "cancel", runId },
						requestId,
						runId,
						false,
						stop,
					);
				}
				case "service-tests.retry-artifact":
					return accepted(
						"retry-artifact",
						requestId,
						service.retryArtifactInTransaction(tx, runIdOf(request.input)),
					);
				default:
					throw new Error("capability_unavailable");
			}
		},
		// Runs are read through the runs source; there is no receipt body to reload.
		readInTransaction: () => null,
		sourceInTransaction(tx, query) {
			if (query === CATALOG) {
				const catalog = service.catalog();
				return {
					revision: catalog.revision,
					data: catalog.targets.map((t) => targetRow(t, catalog.revision)),
				};
			}
			if (query === TARGETS) {
				const catalog = service.catalog();
				return {
					revision: catalog.revision,
					data: {
						options: catalog.targets
							.filter((t) => t.testable)
							.map((t) => ({
								value: t.id,
								label: `${t.name} / ${t.model}（${kindLabels[t.kind]}）`,
							})),
					},
				};
			}
			const runs = service.runsInTransaction(tx);
			if (query === RUNS)
				return { revision: runs.length, data: runs.map(runRow) };
			if (query === STATUS)
				return { revision: runs.length, data: status(runs) };
			if (query === HEALTH) {
				const latest = runs.find((r) => r.kind === "diagnostics");
				const running = latest?.status === "running";
				const rows = (latest?.health ?? []).map((h) => ({
					targetId: h.targetId,
					name: h.name,
					model: h.model,
					state: healthLabels[h.state],
					reason: testErrorLabel(h.reason),
					checkedAt: h.checkedAt,
					latencyMs: h.latencyMs ?? null,
					running,
				}));
				// A diagnosis that has no result yet still shows a row, so the screen keeps reading.
				return {
					revision: runs.length,
					data:
						running && rows.length === 0
							? [
									{
										targetId: "pending",
										name: "Healthを確認しています",
										model: "",
										state: "確認中",
										reason: "",
										checkedAt: null,
										latencyMs: null,
										running,
									},
								]
							: rows,
				};
			}
			return null;
		},
		targetInput: () => ({}),
		// Background work (a test, the diagnosis, a refresh) starts only for a committed write.
		afterCommit() {
			for (const [id, entry] of pending) {
				if (entry.effect() || Date.now() - entry.at > 30_000)
					pending.delete(id);
			}
		},
	};
}
