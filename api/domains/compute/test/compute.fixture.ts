import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createCompute } from "../service";
import { migrations } from "../repository";
import type {
	ComputePort,
	Environment,
	JobView,
	RemoteJob,
} from "../contracts";
export const environment: Environment = {
	protocol: "larm.compute.v1",
	python: "fixture-python",
	packages: [{ name: "numpy", version: "fixture" }],
	accelerators: [{ kind: "cpu", name: "CPU", memoryMiB: 2048 }],
	limits: {
		maxTimeoutSec: 60,
		maxCodeBytes: 65536,
		maxInputBytes: 262144,
		maxArtifactBytes: 5242880,
		maxArtifacts: 10,
	},
	environmentRevision: "fixture-revision",
};
export const remote = (
	status: RemoteJob["status"],
	extra: Partial<RemoteJob> = {},
): RemoteJob => ({
	jobId: crypto.randomUUID(),
	status,
	stage: status,
	queuedAt: new Date().toISOString(),
	startedAt: null,
	finishedAt: null,
	expiresAt: null,
	cancelRequested: false,
	...extra,
});
export const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "compute-")),
		path = join(dir, "db");
	const store = openStore(path, [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 5, maxMs: 5 },
	});
	const calls: Array<{ op: string; key?: string; body?: unknown }> = [];
	const state = {
		binding: "fixture-connection",
		job: remote("completed", {
			result: {
				value: 2,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				artifacts: [],
			},
		}),
		submitError: null as unknown,
		fetchError: null as unknown,
		cancelPending: false,
		submitBarrier: null as Promise<void> | null,
	};
	const port: ComputePort = {
		get binding() {
			return state.binding;
		},
		async discover() {
			return {
				url: "http://compute.test/v1/compute",
				description: "CPU",
				environment,
			};
		},
		async submit(_url, body, key) {
			calls.push({ op: "submit", body, key });
			if (state.submitBarrier) await state.submitBarrier;
			if (state.submitError) throw state.submitError;
			return state.job.jobId;
		},
		async get() {
			calls.push({ op: "get" });
			return state.job;
		},
		async cancel() {
			calls.push({ op: "cancel" });
			return state.cancelPending
				? { ...state.job, cancelRequested: true }
				: state.job.status === "completed"
					? state.job
					: remote("cancelled", { jobId: state.job.jobId });
		},
		async delete() {
			calls.push({ op: "delete" });
			return null;
		},
		async artifact() {
			calls.push({ op: "artifact" });
			if (state.fetchError) throw state.fetchError;
			return png;
		},
	};
	const notices: JobView[] = [];
	let valid = true;
	const service = createCompute({
		store,
		queue,
		port: () => port,
		pollMs: 5,
		onFinished: (_db, j) => notices.push(j),
		validInTransaction: () => valid,
	});
	await service.refresh();
	queue.start();
	return {
		service,
		store,
		queue,
		path,
		state,
		calls,
		port,
		notices,
		setValid: (v: boolean) => {
			valid = v;
		},
		async close() {
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
