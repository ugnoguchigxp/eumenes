import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { createCompute } from "../service";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations } from "../repository";
import { fixture, remote, png } from "./compute.fixture";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function setup() {
	const f = await fixture();
	cleanup.push(f.close);
	return f;
}
const until = (check: () => boolean) =>
	waitFor(check, { timeout: 3000, interval: 5 });

test("persists key and body before HTTP, adopts result and replays an identical command", async () => {
	const f = await setup(),
		request = crypto.randomUUID();
	const first = await f.service.submit(
		"owner",
		"main",
		{ code: "result = 1 + 1" },
		request,
	);
	await until(() => f.service.get("owner", first.jobId).state === "completed");
	expect(f.service.get("owner", first.jobId).result?.value).toBe(2);
	const persisted = f.store.read((db) =>
		db
			.query(
				"SELECT idempotency_key,body_json,job_id FROM compute_jobs WHERE id=?",
			)
			.get(first.jobId),
	) as { idempotency_key: string; body_json: string; job_id: string };
	expect(f.calls.find((c) => c.op === "submit")).toMatchObject({
		key: persisted.idempotency_key,
		body: JSON.parse(persisted.body_json),
	});
	expect(persisted.job_id).toBe(f.state.job.jobId);
	expect(
		await f.service.submit(
			"owner",
			"main",
			{ code: "result = 1 + 1" },
			request,
		),
	).toEqual(first);
	expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	await expect(
		f.service.submit("owner", "main", { code: "result = 3" }, request),
	).rejects.toThrow("request_conflict");
	expect(() => f.service.get("other", first.jobId)).toThrow(
		"compute_not_found",
	);
});
test("ambiguous submit is never automatically retried; explicit recovery preserves key/body", async () => {
	const f = await setup();
	f.state.submitError = new TypeError("private upstream text");
	const accepted = await f.service.submit(
		"owner",
		"main",
		{ code: "result = 2", inputs: { x: [1, 2] } },
		crypto.randomUUID(),
	);
	await until(
		() => f.service.get("owner", accepted.jobId).state === "indeterminate",
	);
	expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	f.state.submitError = null;
	await f.service.reconcile("owner", accepted.jobId);
	await until(
		() => f.service.get("owner", accepted.jobId).state === "completed",
	);
	const calls = f.calls.filter((c) => c.op === "submit");
	expect(calls).toHaveLength(2);
	expect(calls[0]).toEqual(calls[1]);
	expect(JSON.stringify(f.service.get("owner", accepted.jobId))).not.toContain(
		"private upstream text",
	);
});
test.each([
	"timeout",
	"memory_exceeded",
	"syntax_error",
	"runtime_error",
	"queue_timeout",
	"output_exceeded",
])("HTTP success with %s is a failed calculation", async (code) => {
	const f = await setup();
	f.state.job = remote("failed", {
		error: { code, message: "fixture traceback" },
	});
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "invalid code" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", a.jobId).state === "failed");
	expect(f.service.get("owner", a.jobId).error).toEqual({
		code,
		message: "fixture traceback",
	});
	expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
});
test("cancel 202 remains running until confirmed, completion race stays completed, another job succeeds", async () => {
	const f = await setup();
	f.state.job = remote("running", {
		progress: { message: "half", ratio: 0.5 },
	});
	f.state.cancelPending = true;
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", a.jobId).state === "running");
	await f.service.cancel("owner", a.jobId);
	await until(() => f.calls.some((c) => c.op === "cancel"));
	expect(f.service.get("owner", a.jobId)).toMatchObject({
		state: "running",
		cancelRequested: true,
		progress: { ratio: 0.5 },
	});
	f.state.job = remote("cancelled", { jobId: f.state.job.jobId });
	await until(() => f.service.get("owner", a.jobId).state === "cancelled");
	expect(f.calls.some((c) => c.op === "delete")).toBe(false);
	f.state.job = remote("completed", {
		result: {
			value: 8,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [],
		},
	});
	const b = await f.service.submit(
		"owner",
		"main",
		{ code: "result=8" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", b.jobId).state === "completed");
	await f.service.cancel("owner", b.jobId);
	expect(f.service.get("owner", b.jobId).result?.value).toBe(8);
});
test("cancelling while submit is in flight waits for the saved jobId then calls cancel", async () => {
	const f = await setup();
	let release!: () => void;
	f.state.submitBarrier = new Promise<void>((r) => {
		release = r;
	});
	f.state.job = remote("running");
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await until(() => f.calls.some((c) => c.op === "submit"));
	await f.service.cancel("owner", a.jobId);
	release();
	await until(() => f.service.get("owner", a.jobId).state === "cancelled");
	expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	expect(f.calls.some((c) => c.op === "cancel")).toBe(true);
});
test("imports artifacts without deleting remote results, and separates artifact failure", async () => {
	const f = await setup(),
		artifactId = crypto.randomUUID();
	f.state.job = remote("completed", {
		result: {
			value: 6,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [
				{
					id: artifactId,
					name: "figure.png",
					mime: "image/png",
					bytes: png.length,
				},
			],
		},
	});
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "plot()" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", a.jobId).state === "completed");
	expect(f.service.artifact("owner", a.jobId, artifactId).content).toEqual(png);
	expect(f.calls.some((c) => c.op === "delete")).toBe(false);
	f.state.fetchError = { code: "job_expired", status: 410 };
	const b = await f.service.submit(
		"owner",
		"main",
		{ code: "plot()" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", b.jobId).state === "completed");
	expect(f.service.get("owner", b.jobId)).toMatchObject({
		artifactError: "job_expired",
		result: { value: 6 },
		artifacts: [{ ready: false }],
	});
});
test.each([429, 503])(
	"submit HTTP %i is recorded without resending the POST",
	async (status) => {
		const f = await setup();
		f.state.submitError = {
			status,
			code: status === 429 ? "queue_full" : "unavailable",
			retryAfterMs: 8000,
		};
		const a = await f.service.submit(
			"owner",
			"main",
			{ code: "result=2" },
			crypto.randomUUID(),
		);
		await until(() => f.service.get("owner", a.jobId).state === "failed");
		expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	},
);
test("token rotation refuses old jobs and capacity/UTF-8 limits reject before POST", async () => {
	const f = await setup();
	await expect(
		f.service.submit(
			"owner",
			"main",
			{ code: "あ".repeat(30000) },
			crypto.randomUUID(),
		),
	).rejects.toThrow("invalid_request");
	f.state.job = remote("running");
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", a.jobId).state === "running");
	await expect(
		f.service.submit(
			"owner",
			"main",
			{ code: "result=3" },
			crypto.randomUUID(),
		),
	).rejects.toThrow("compute_capacity");
	f.state.binding = "rotated";
	await until(() => f.service.get("owner", a.jobId).state === "indeterminate");
	expect(f.service.get("owner", a.jobId).error?.code).toBe(
		"compute_connection_changed",
	);
});
test("invalidated parent cannot adopt completion and is stopped", async () => {
	const f = await setup();
	f.state.job = remote("running");
	const a = await f.store.write((db) =>
		f.service.commandInTransaction(
			db,
			"owner",
			"main",
			"conversation",
			"python_submit",
			{ code: "result=2" },
			crypto.randomUUID(),
		),
	);
	await until(() => f.service.get("owner", a.value.jobId).state === "running");
	f.setValid(false);
	await until(
		() => f.service.get("owner", a.value.jobId).state === "cancelled",
	);
	expect(f.notices).toEqual([]);
});
test("reopening the database resumes polling by saved jobId without a new submit", async () => {
	const f = await setup();
	f.state.job = remote("running");
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await until(() => f.service.get("owner", a.jobId).state === "running");
	await f.queue.close(100);
	await f.store.close();
	const store = openStore(f.path, [...queueMigrations, ...migrations]),
		queue = createQueue(store, { pollMs: 5 });
	const service = createCompute({
		store,
		queue,
		port: () => f.port,
		pollMs: 5,
	});
	f.state.job = remote("completed", {
		jobId: f.state.job.jobId,
		result: {
			value: 2,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [],
		},
	});
	await queue.recover();
	queue.start();
	try {
		await until(() => service.get("owner", a.jobId).state === "completed");
		expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(1);
	} finally {
		await queue.close(100);
		await store.close();
	}
});

test("defaulted and explicit CPU request fields share a normalized replay", async () => {
	const f = await setup(),
		key = crypto.randomUUID();
	const a = await f.service.submit("owner", "main", { code: "result=2" }, key);
	expect(
		await f.service.submit(
			"owner",
			"main",
			{ code: "result=2", inputs: {}, timeoutSec: 60, accelerator: "auto" },
			key,
		),
	).toEqual(a);
});
