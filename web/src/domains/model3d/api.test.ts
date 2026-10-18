import { expect, test, vi } from "vitest";
import type { Transport } from "../../../../client/transport";
import { GlbTooLargeError, model3dApi } from "./api";
import { maxGlbBytes } from "./contracts";

function transport(response: Response) {
	return {
		call: vi.fn(async () => response),
		identity: "http://localhost",
	} as unknown as Transport & {
		call: ReturnType<typeof vi.fn>;
	};
}
const jsonResponse = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
	});

test("assets sends the filter and cursor, joining tags with commas", async () => {
	const t = transport(jsonResponse({ assets: [], total: 0, nextCursor: null }));
	await model3dApi(t).assets(
		{ q: "ロボット", tags: ["試作", "青"], sort: "relevance", order: "asc" },
		"c1",
	);
	const url = new URL(String(t.call.mock.calls[0]?.[0]), "http://x");
	expect(url.pathname).toBe("/api/model3d/assets");
	expect(Object.fromEntries(url.searchParams)).toEqual({
		q: "ロボット",
		tags: "試作,青",
		sort: "relevance",
		order: "asc",
		limit: "20",
		cursor: "c1",
	});
	const bare = transport(
		jsonResponse({ assets: [], total: 0, nextCursor: null }),
	);
	await model3dApi(bare).assets({
		q: "",
		tags: [],
		sort: "createdAt",
		order: "desc",
	});
	const params = new URL(String(bare.call.mock.calls[0]?.[0]), "http://x")
		.searchParams;
	expect([...params.keys()].sort()).toEqual(["limit", "order", "sort"]);
});

test("createGeneration posts JSON and update uses PATCH", async () => {
	const generation = {
		id: "g",
		title: "t",
		tags: [],
		source: { type: "prompt", prompt: "p" },
		state: "queued",
		stage: null,
		stageLabel: "受付済み・待機中",
		assetId: null,
		deleted: false,
		warnings: [],
		errorCode: null,
		errorLabel: null,
		origin: "screen",
		createdAt: 1,
		updatedAt: 1,
		revision: 1,
	};
	const t = transport(jsonResponse(generation));
	const body = {
		requestId: crypto.randomUUID(),
		title: "t",
		tags: [],
		source: { type: "prompt" as const, prompt: "p" },
	};
	await model3dApi(t).createGeneration(body);
	expect(t.call).toHaveBeenCalledWith(
		"/api/model3d/generations",
		expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
	);
	const u = transport(
		jsonResponse({
			id: "a/1",
			title: "n",
			tags: [],
			createdAt: "2026-10-18T00:00:00Z",
			prompt: null,
			warnings: [],
			hasSource: false,
		}),
	);
	await model3dApi(u).updateAsset("a/1", { title: "n" });
	expect(u.call).toHaveBeenCalledWith(
		"/api/model3d/assets/a%2F1",
		expect.objectContaining({
			method: "PATCH",
			body: JSON.stringify({ title: "n" }),
		}),
	);
});

test("a drifted answer fails at the contract", async () => {
	await expect(
		model3dApi(transport(jsonResponse({ assets: "x" }))).assets({
			q: "",
			tags: [],
			sort: "createdAt",
			order: "desc",
		}),
	).rejects.toThrow();
});

test("assetContent returns the bytes and refuses a file over the cap", async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const ok = await model3dApi(transport(new Response(bytes))).assetContent(
		"a1",
	);
	expect(new Uint8Array(ok)).toEqual(bytes);

	const declared = new Response(bytes, {
		headers: { "Content-Length": String(maxGlbBytes + 1) },
	});
	await expect(
		model3dApi(transport(declared)).assetContent("a1"),
	).rejects.toBeInstanceOf(GlbTooLargeError);

	// Without a declared length the cap is enforced while the body streams.
	const chunk = new Uint8Array(1024 * 1024);
	let sent = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			sent += 1;
			controller.enqueue(chunk);
			if (sent > 80) controller.close();
		},
	});
	await expect(
		model3dApi(transport(new Response(stream))).assetContent("a1"),
	).rejects.toBeInstanceOf(GlbTooLargeError);
	expect(sent).toBeLessThan(80);
});

test("deleteAsset sends DELETE and tolerates an empty 204 body", async () => {
	const t = transport(new Response(null, { status: 204 }));
	await model3dApi(t).deleteAsset("a1");
	expect(t.call).toHaveBeenCalledWith("/api/model3d/assets/a1", {
		method: "DELETE",
	});
});
