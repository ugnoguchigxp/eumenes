import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	fixture,
	remote,
	png,
} from "../../domains/compute/test/compute.fixture";
import { registerCompute } from "../../domains/compute";
import { answerError } from "../app";
import {
	createComputeAdapter,
	describeComputeAdapter,
} from "./compute-adapter";
import { CONVERSATION_DEFAULT_PRINCIPAL as owner } from "../../domains/conversation/contracts";
import { waitFor } from "../../infrastructure/wait-for";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of clean.splice(0)) await c();
});
test("registered adapter exposes four schemas and stable receipts, then tracks actual completion", async () => {
	const f = await fixture();
	clean.push(f.close);
	const adapter = createComputeAdapter(f.service);
	expect([...describeComputeAdapter().operations.keys()]).toEqual([
		"compute.submit",
		"compute.status",
		"compute.cancel",
		"compute.artifact",
	]);
	const request = {
		operationName: "compute.submit",
		input: { code: "result = 1 + 1" },
		requestId: crypto.randomUUID(),
		issuedAt: new Date().toISOString(),
		origin: {
			kind: "conversation" as const,
			owner: { rootRunId: "run", taskId: "task", cancelEpoch: 0 },
			runId: "run",
			conversationId: "main",
			messageId: "message",
		},
	};
	const accepted = await f.store.write((db) =>
		adapter.invokeInTransaction(db, request),
	);
	expect(
		(await f.store.write((db) => adapter.invokeInTransaction(db, request)))
			.receiptRef,
	).toEqual(accepted.receiptRef);
	await waitFor(() => f.service.list(owner)[0]?.state === "completed");
	expect(
		f.store.read((db) => adapter.readInTransaction(db, request.requestId))
			?.receiptRef,
	).toEqual(accepted.receiptRef);
	const status = await f.store.write((db) =>
		adapter.invokeInTransaction(db, {
			...request,
			operationName: "compute.status",
			input: { jobId: f.service.list(owner)[0]!.id },
			requestId: crypto.randomUUID(),
		}),
	);
	expect(status.answerContext).toMatchObject({ kind: "compute" });
	expect(JSON.stringify(status)).toContain('"value":2');
	await expect(
		f.store.write((db) =>
			adapter.invokeInTransaction(db, {
				...request,
				operationName: "compute.cancel",
				input: { jobId: crypto.randomUUID() },
				requestId: crypto.randomUUID(),
			}),
		),
	).rejects.toThrow("compute_not_found");
});
test("authenticated host integration serves stored PNG and downloads SVG without inline HTML", async () => {
	const f = await fixture();
	clean.push(f.close);
	const pngId = crypto.randomUUID();
	f.state.job = remote("completed", {
		result: {
			value: 3,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			artifacts: [
				{
					id: pngId,
					name: 'plot"\n.png',
					mime: "image/png",
					bytes: png.length,
				},
			],
		},
	});
	const a = await f.service.submit(
		owner,
		"main",
		{ code: "plot" },
		crypto.randomUUID(),
	);
	await waitFor(() => f.service.get(owner, a.jobId).state === "completed");
	const app = new Hono();
	app.onError(answerError);
	app.use("*", async (c, next) => {
		if (c.req.header("Authorization") !== "Bearer fixture-api")
			return c.json({ error: "unauthorized" }, 401);
		await next();
	});
	registerCompute(app, f.service, owner);
	expect(
		(await app.request(`/api/compute/jobs/${a.jobId}/artifacts/${pngId}`))
			.status,
	).toBe(401);
	const headers = { Authorization: "Bearer fixture-api" };
	const image = await app.request(
		`/api/compute/jobs/${a.jobId}/artifacts/${pngId}`,
		{ headers },
	);
	expect(image.headers.get("content-type")).toBe("image/png");
	expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
	expect(image.headers.get("content-disposition")).not.toContain("\n");
	const svgId = crypto.randomUUID();
	await f.store.write((db) =>
		db
			.query("INSERT INTO compute_artifacts VALUES(?,?,?,?,?,?)")
			.run(
				a.jobId,
				svgId,
				"unsafe.svg",
				"image/svg+xml",
				6,
				new TextEncoder().encode("<svg/>"),
			),
	);
	const svg = await app.request(
		`/api/compute/jobs/${a.jobId}/artifacts/${svgId}`,
		{ headers },
	);
	expect(svg.headers.get("content-disposition")).toStartWith("attachment;");
	expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
	expect(svg.headers.get("content-security-policy")).toContain("sandbox");
	expect(
		(
			await app.request(
				`/api/compute/jobs/${crypto.randomUUID()}/artifacts/${svgId}`,
				{ headers },
			)
		).status,
	).toBe(404);
});

test("parent cancellation confirms remote termination outside the writer and does not claim it during 202", async () => {
	const f = await fixture();
	clean.push(f.close);
	const adapter = createComputeAdapter(f.service);
	f.state.job = remote("running");
	f.state.cancelPending = true;
	const requestId = crypto.randomUUID();
	const accepted = await f.store.write((db) =>
		adapter.invokeInTransaction(db, {
			operationName: "compute.submit",
			input: { code: "result=2" },
			requestId,
			issuedAt: new Date().toISOString(),
			origin: {
				kind: "conversation",
				owner: { rootRunId: "run", taskId: "task", cancelEpoch: 0 },
				runId: "run",
				conversationId: "main",
				messageId: "message",
			},
		}),
	);
	const jobId = (accepted.receipt as { jobId: string }).jobId;
	await waitFor(() => f.service.get(owner, jobId).state === "running");
	const child = { deadline: Date.now() + 30000 } as never;
	await f.store.write((db) =>
		adapter.execution!.cancelInTransaction(db, requestId, child),
	);
	let settled = false;
	const confirmation = adapter.execution!.stop!(requestId).then((v) => {
		settled = true;
		return v;
	});
	await waitFor(() => f.calls.some((c) => c.op === "cancel"));
	expect(settled).toBe(false);
	expect(
		f.store.read((db) =>
			adapter.execution!.currentInTransaction(db, requestId, child),
		).state,
	).toBe("running");
	f.state.job = remote("cancelled", { jobId: f.state.job.jobId });
	expect(await confirmation).toBe(true);
});
