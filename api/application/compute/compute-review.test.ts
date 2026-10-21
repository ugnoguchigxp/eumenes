import { expect, test } from "bun:test";
import { fixture } from "../../domains/compute/test/compute.fixture";
import { createComputeAdapter } from "./compute-adapter";
import { CONVERSATION_DEFAULT_PRINCIPAL as owner } from "../../domains/conversation/contracts";
import { waitFor } from "../../infrastructure/wait-for";

test("older owned jobs remain addressable outside the bounded model snapshot and replay stays stable", async () => {
	const f = await fixture();
	try {
		const adapter = createComputeAdapter(f.service);
		const jobs: string[] = [];
		for (let i = 0; i < 12; i++) {
			const a = await f.service.submit(
				owner,
				"main",
				{ code: `result=${i}` },
				crypto.randomUUID(),
			);
			jobs.push(a.jobId);
			await waitFor(() => f.service.get(owner, a.jobId).state === "completed");
		}
		const request = {
			operationName: "compute.status",
			input: { jobId: jobs[0] },
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
		const result = await f.store.write((db) =>
			adapter.invokeInTransaction(db, request),
		);
		expect(result.receipt).toMatchObject({ jobId: jobs[0] });
		expect(
			(await f.store.write((db) => adapter.invokeInTransaction(db, request)))
				.receiptRef,
		).toEqual(result.receiptRef);
		await expect(
			f.store.write((db) =>
				adapter.invokeInTransaction(db, {
					...request,
					requestId: crypto.randomUUID(),
					origin: { ...request.origin, conversationId: "other" },
				}),
			),
		).rejects.toThrow("compute_not_found");
	} finally {
		await f.close();
	}
});

test("offline compute with no history remains listed and opens its empty artifact without enabling submissions", async () => {
	const { harness } = await import("../toolchain/toolchain.fixture");
	const f = await fixture();
	f.port.discover = async () => {
		throw new Error("offline");
	};
	const h = await harness({ computePort: f.port });
	try {
		expect(h.store.read((db) => h.compute!.availableInTransaction(db))).toBe(
			false,
		);
		const listing = await h.request("/api/toolchain-artifacts");
		expect(listing.status).toBe(200);
		expect(JSON.stringify(await listing.json())).toContain(
			"artifact:compute.workspace@1",
		);
		const view = await h.request(
			"/api/toolchain-artifacts/artifact:compute.workspace@1",
		);
		expect(view.status).toBe(200);
		const source = await h.request(
			"/api/toolchain-artifacts/artifact:compute.workspace@1/sources/compute",
		);
		expect(source.status).toBe(200);
		expect((await source.json()).data).toMatchObject({
			environment: null,
			jobs: [],
		});
		await expect(
			h.compute!.submit(
				owner,
				"main",
				{ code: "result=2" },
				crypto.randomUUID(),
			),
		).rejects.toThrow("compute_service_unavailable");
	} finally {
		await h.close();
		await f.close();
	}
});
