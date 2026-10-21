import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { createCompute, migrations } from "../../domains/compute";
import { createComputeClient } from "../../domains/larm";
import { waitFor } from "../../infrastructure/wait-for";
import { environment } from "../../domains/compute/test/compute.fixture";

test("real client and queue use the advertised URL and persist the request before HTTP", async () => {
	const dir = mkdtempSync(join(tmpdir(), "compute-http-")),
		store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]),
		queue = createQueue(store, { pollMs: 5 });
	const remoteId = crypto.randomUUID(),
		artifactId = crypto.randomUUID();
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lGkAAAAASUVORK5CYII=",
		"base64",
	);
	const posts: string[] = [];
	const client = createComputeClient({
		baseUrl: "http://compute.test",
		token: "fixture-secret",
		fetch: (async (url, init) => {
			const path = new URL(String(url)).pathname;
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer fixture-secret",
			);
			if (path === "/v3/agent-profiles")
				return Response.json({
					services: [
						{
							capability: "compute.python.execute",
							protocol: "larm.compute.v1",
							url: "http://compute.test/advertised/compute",
							description: "CPU",
						},
					],
				});
			if (path.endsWith("/environment"))
				return Response.json({
					...environment,
					sandbox: {
						network: false,
						gpu: false,
						subprocesses: false,
						userThreads: false,
						memoryAccounting: "address_space",
					},
				});
			if (path === "/advertised/compute/jobs" && init?.method === "POST") {
				posts.push(path);
				const saved = store.read((db) =>
					db
						.query("SELECT idempotency_key,body_json,sent FROM compute_jobs")
						.get(),
				) as { idempotency_key: string; body_json: string; sent: number };
				expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
					saved.idempotency_key,
				);
				expect(JSON.parse(String(init.body))).toEqual(
					JSON.parse(saved.body_json),
				);
				expect(saved.sent).toBe(1);
				return Response.json({ jobId: remoteId }, { status: 202 });
			}
			if (path.endsWith(`/artifacts/${artifactId}`))
				return new Response(png, { headers: { "Content-Type": "image/png" } });
			expect(path).toBe(`/advertised/compute/jobs/${remoteId}`);
			return Response.json({
				jobId: remoteId,
				status: "completed",
				stage: "completed",
				queuedAt: "now",
				startedAt: null,
				finishedAt: "now",
				expiresAt: null,
				resolvedAccelerator: "cpu",
				environmentRevision: "r",
				cancelRequested: false,
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
		}) as typeof fetch,
	});
	const service = createCompute({
		store,
		queue,
		port: () => client,
		pollMs: 5,
	});
	try {
		await service.refresh();
		queue.start();
		const accepted = await service.submit(
			"owner",
			"main",
			{ code: "result=sum(inputs['values'])", inputs: { values: [1, 2, 3] } },
			crypto.randomUUID(),
		);
		await waitFor(
			() => service.get("owner", accepted.jobId).state === "completed",
		);
		expect(posts).toHaveLength(1);
		expect(service.get("owner", accepted.jobId).result?.value).toBe(6);
		expect(
			service.artifact("owner", accepted.jobId, artifactId).content,
		).toEqual(png);
	} finally {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
