import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerToolchainActions } from "..";
import { ARTIFACT_ID, makeHarness } from "./action-fixture";

let h = makeHarness();
afterEach(async () => {
	await h.close();
});
function app() {
	h = makeHarness();
	const hono = new Hono();
	registerToolchainActions(hono, h.service);
	const post = (body: unknown) =>
		hono.request("/api/toolchain-actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return { hono, post };
}

test("POST maps outcomes to status codes and GET reads back by eventId", async () => {
	const { hono, post } = app();
	const event = h.event();
	const created = await post(event);
	expect(created.status).toBe(200);
	const body = (await created.json()) as {
		status: string;
		result: { receipt: unknown };
	};
	expect(body.status).toBe("accepted");
	expect(body.result.receipt).toBeTruthy();
	expect(created.headers.get("idempotent-replay")).toBeNull();

	const replay = await post(event);
	expect(replay.status).toBe(200);
	expect(replay.headers.get("idempotent-replay")).toBe("true");
	expect(h.effects()).toBe(1);

	const conflict = await post({
		...event,
		input: { hours: "1", minutes: "0", seconds: "0" },
	});
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toEqual({ error: "request_conflict" });

	const field = await post(
		h.event({ input: { hours: "x", minutes: "0", seconds: "0" } }),
	);
	expect(field.status).toBe(422);
	expect(await field.json()).toEqual({
		error: "invalid_input",
		fieldErrors: [{ field: "hours", message: "digits_required" }],
	});

	const old = new Date(h.time.value - 25 * 3_600_000).toISOString();
	const expired = await post(
		h.event({
			eventCreatedAt: old,
			eventExpiresAt: new Date(h.time.value - 3_600_000).toISOString(),
		}),
	);
	expect(expired.status).toBe(410);

	expect((await post("{not json")).status).toBe(400);
	expect((await post({ version: 2 })).status).toBe(400);
	expect((await post(JSON.stringify({ pad: "x".repeat(40_000) }))).status).toBe(
		413,
	);

	const read = await hono.request(`/api/toolchain-actions/${event.eventId}`);
	expect(read.status).toBe(200);
	expect(((await read.json()) as { eventId: string }).eventId).toBe(
		event.eventId,
	);
	expect(
		(await hono.request(`/api/toolchain-actions/${crypto.randomUUID()}`))
			.status,
	).toBe(404);
	expect((await hono.request("/api/toolchain-actions/not-a-uuid")).status).toBe(
		400,
	);
});

test("unsettled list, launcher list, artifact and source endpoints", async () => {
	const { hono } = app();
	const unsettled = await hono.request(
		"/api/toolchain-actions?status=unsettled",
	);
	expect(unsettled.status).toBe(200);
	expect(await unsettled.json()).toEqual({ requests: [] });
	expect((await hono.request("/api/toolchain-actions")).status).toBe(400);

	const list = (await (
		await hono.request("/api/toolchain-artifacts")
	).json()) as { artifacts: Array<{ artifactRevisionId: string }> };
	expect(list.artifacts.map((a) => a.artifactRevisionId)).toEqual([
		ARTIFACT_ID,
	]);

	const artifact = await hono.request(
		`/api/toolchain-artifacts/${encodeURIComponent(ARTIFACT_ID)}`,
	);
	expect(artifact.status).toBe(200);
	const view = (await artifact.json()) as {
		artifactRevisionId: string;
		scopeRef: string;
		digest: string;
	};
	expect(view).toMatchObject({
		artifactRevisionId: ARTIFACT_ID,
		scopeRef: h.service.scopeRef,
	});
	expect(
		(await hono.request("/api/toolchain-artifacts/artifact:missing@1")).status,
	).toBe(404);
	expect((await hono.request("/api/toolchain-artifacts/bad")).status).toBe(400);

	const source = await hono.request(
		`/api/toolchain-artifacts/${ARTIFACT_ID}/sources/item?target=item-1`,
	);
	expect(await source.json()).toEqual({
		revision: 3,
		data: { id: "item-1", state: "active" },
	});
	expect(
		(await hono.request(`/api/toolchain-artifacts/${ARTIFACT_ID}/sources/item`))
			.status,
	).toBe(400);
	expect(
		(
			await hono.request(
				`/api/toolchain-artifacts/${ARTIFACT_ID}/sources/item?target=zzz`,
			)
		).status,
	).toBe(404);
	expect(
		(
			await hono.request(
				`/api/toolchain-artifacts/${ARTIFACT_ID}/sources/Bad_Name`,
			)
		).status,
	).toBe(400);
	h.setAvailable(() => false);
	expect(
		(await hono.request(`/api/toolchain-artifacts/${ARTIFACT_ID}`)).status,
	).toBe(503);
});
