import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { fixture, remote } from "./compute.fixture";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0)) await close();
});
async function setup() {
	const f = await fixture();
	clean.push(f.close);
	return f;
}

test("reconciliation preserves the original deadline and refuses expired unknown submissions", async () => {
	const f = await setup();
	f.state.submitError = new TypeError("disconnected");
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await waitFor(
		() => f.service.get("owner", a.jobId).state === "indeterminate",
	);
	const deadline = Date.now() + 60000;
	await f.store.write((db) =>
		db
			.query("UPDATE compute_jobs SET deadline=? WHERE id=?")
			.run(deadline, a.jobId),
	);
	await f.service.reconcile("owner", a.jobId);
	await waitFor(
		() => f.service.get("owner", a.jobId).state === "indeterminate",
	);
	expect(
		f.store.read(
			(db) =>
				(
					db
						.query("SELECT deadline FROM compute_jobs WHERE id=?")
						.get(a.jobId) as { deadline: number }
				).deadline,
		),
	).toBe(deadline);
	await f.store.write((db) =>
		db
			.query("UPDATE compute_jobs SET deadline=? WHERE id=?")
			.run(Date.now() - 1, a.jobId),
	);
	await expect(f.service.reconcile("owner", a.jobId)).rejects.toThrow(
		"compute_not_reconcilable",
	);
	expect(f.calls.filter((c) => c.op === "submit")).toHaveLength(2);
});

test("Retry-After cannot postpone deadline cancellation", async () => {
	const f = await setup();
	f.state.job = remote("running");
	let release!: () => void;
	const blocked = new Promise<void>((r) => {
		release = r;
	});
	f.port.get = async () => {
		await blocked;
		throw { status: 503, code: "unavailable", retryAfterMs: 3600000 };
	};
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await waitFor(() => f.service.get("owner", a.jobId).state === "queued");
	await f.store.write((db) =>
		db
			.query("UPDATE compute_jobs SET deadline=? WHERE id=?")
			.run(Date.now() + 50, a.jobId),
	);
	release();
	await waitFor(() => f.service.get("owner", a.jobId).state === "cancelled", {
		timeout: 2000,
		interval: 5,
	});
	expect(f.calls.some((c) => c.op === "cancel")).toBe(true);
});

test("an accepted asynchronous deletion continues to deletion after the job terminates", async () => {
	const f = await setup();
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await waitFor(() => f.service.get("owner", a.jobId).state === "completed");
	let deletes = 0;
	f.port.delete = async () => {
		deletes++;
		return deletes === 1
			? remote("running", { jobId: f.state.job.jobId, cancelRequested: true })
			: null;
	};
	await f.service.delete("owner", a.jobId);
	await waitFor(() => f.service.get("owner", a.jobId).state === "deleted", {
		timeout: 1000,
		interval: 5,
	});
	expect(deletes).toBe(2);
});

test("one expired artifact does not discard other downloaded artifacts or redownload them on recovery", async () => {
	const f = await setup();
	const ids = [crypto.randomUUID(), crypto.randomUUID()] as const;
	f.state.job = remote("completed", {
		result: {
			value: 2,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: ids.map((id, i) => ({
				id,
				name: `${i}.csv`,
				mime: "text/csv" as const,
				bytes: 1,
			})),
		},
	});
	const downloaded: string[] = [];
	let expired = true;
	f.port.artifact = async (_url, _job, a) => {
		downloaded.push(a.id);
		if (a.id === ids[1] && expired) throw { code: "job_expired", status: 410 };
		return new Uint8Array([1]);
	};
	const a = await f.service.submit(
		"owner",
		"main",
		{ code: "result=2" },
		crypto.randomUUID(),
	);
	await waitFor(() => f.service.get("owner", a.jobId).state === "completed");
	expect(f.service.get("owner", a.jobId).artifacts.map((a) => a.ready)).toEqual(
		[true, false],
	);
	expired = false;
	await f.store.write((db) =>
		f.service.commandInTransaction(
			db,
			"owner",
			"main",
			"screen",
			"python_artifact",
			{ jobId: a.jobId, artifactId: ids[1] },
			crypto.randomUUID(),
		),
	);
	await waitFor(() =>
		f.service.get("owner", a.jobId).artifacts.every((a) => a.ready),
	);
	expect(downloaded).toEqual([ids[0], ids[1], ids[1]]);
});

test("parent invalidation during artifact IO suppresses completion adoption and notices", async () => {
	const f = await setup();
	f.state.job = remote("completed", {
		result: {
			value: 2,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [
				{
					id: crypto.randomUUID(),
					name: "data.csv",
					mime: "text/csv",
					bytes: 1,
				},
			],
		},
	});
	f.port.artifact = async () => {
		f.setValid(false);
		return new Uint8Array([1]);
	};
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
	await waitFor(
		() => f.service.get("owner", a.value.jobId).state === "completed",
	);
	expect(f.notices).toEqual([]);
	expect(
		f.store.read(
			(db) =>
				(
					db
						.query("SELECT invalidated FROM compute_jobs WHERE id=?")
						.get(a.value.jobId) as { invalidated: number }
				).invalidated,
		),
	).toBe(1);
});
