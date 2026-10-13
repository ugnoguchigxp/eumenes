import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { imageFixture } from "./image.fixture";
const authorization = "Bearer fixture-token-for-toolchain-browser";
test("image API physically removes the fixture bytes and metadata with authorization", async () => {
	const f = imageFixture("studio");
	const h = await harness({ model: f.model, imageGateway: f.gateway });
	try {
		expect(
			(await h.app.request("/api/images/past-image", { method: "DELETE" }))
				.status,
		).toBe(401);
		expect(
			(
				await h.app.request("/api/images/bad%2Fid", {
					method: "DELETE",
					headers: { authorization },
				})
			).status,
		).toBe(400);
		expect(f.requests).toHaveLength(0);
		const result = await h.app.request("/api/images/past-image", {
			method: "DELETE",
			headers: { authorization },
		});
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({ id: "past-image", deleted: true });
		expect(f.images.has("past-image")).toBe(false);
		expect(await (await h.request("/api/images/library")).json()).toMatchObject(
			{ images: [], totalBytes: 0 },
		);
		expect((await h.request("/api/images/past-image/content")).status).not.toBe(
			200,
		);
		expect(
			(
				await h.app.request("/api/images/past-image", {
					method: "DELETE",
					headers: { authorization },
				})
			).status,
		).toBe(404);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
		expect(
			f.requests.every((r) => r.auth === "Bearer fixture-image-secret"),
		).toBe(true);
		expect(f.requests.some((r) => r.method === "POST")).toBe(false);
	} finally {
		await h.close();
	}
});
test("unconfirmed physical deletion preserves the image and returns a safe failure", async () => {
	const f = imageFixture("studio");
	f.setDeleteFailure(503);
	const h = await harness({ model: f.model, imageGateway: f.gateway });
	try {
		const result = await h.app.request("/api/images/past-image", {
			method: "DELETE",
			headers: { authorization },
		});
		expect(result.status).toBe(502);
		expect(await result.json()).toEqual({ error: "image_delete_unconfirmed" });
		expect(f.images.has("past-image")).toBe(true);
		expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
	} finally {
		await h.close();
	}
});
