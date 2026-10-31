import { afterEach, expect, test } from "bun:test";
import { cleanup, setup } from "../domains/inference/test/inference.fixture";
import { createApp } from "./app";
import { registerInference } from "../domains/inference";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("screen notifications use existing API authentication, enforce origin and a bounded contract, and fence stale delivery", async () => {
	const h = await setup();
	const seen: boolean[] = [];
	h.port.retain = (active) => seen.push(active);
	const token = "t".repeat(32);
	const app = createApp({
		token,
		origin: "http://localhost",
		modules: [{ mount: (a) => registerInference(a, h.inference) }],
	});
	const path = `/api/inference/screen/${crypto.randomUUID()}`;
	const auth = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const update = (revision: number, active: boolean) =>
		JSON.stringify({ revision, active, sentAt: Date.now() });
	const request = (body: string, headers: Record<string, string> = auth) =>
		app.request(path, { method: "PUT", headers, body });
	expect((await request(update(1, true), {})).status).toBe(401);
	expect(
		(await request(update(1, true), { ...auth, origin: "http://evil.example" }))
			.status,
	).toBe(403);
	for (const body of [
		"{",
		JSON.stringify({ revision: 0, active: true, sentAt: Date.now() }),
		JSON.stringify({ revision: 1, active: "true", sentAt: Date.now() }),
		JSON.stringify({ revision: 1, active: true, sentAt: Date.now(), extra: 1 }),
	])
		expect((await request(body)).status).toBe(400);
	expect((await request(" ".repeat(257))).status).toBe(413);
	expect(
		(
			await request(
				JSON.stringify({
					revision: 1,
					active: true,
					sentAt: Date.now() - 90_001,
				}),
			)
		).status,
	).toBe(409);
	expect(seen).toEqual([]);
	const answer = async (body: string) => {
		const response = await request(body);
		return [response.status, await response.json()];
	};
	// The only screen plays sound, hidden or not; a stale report changes nothing.
	expect(await answer(update(1, true))).toEqual([
		200,
		{ playbackScreen: true },
	]);
	expect(await answer(update(3, false))).toEqual([
		200,
		{ playbackScreen: true },
	]);
	expect(await answer(update(2, true))).toEqual([
		200,
		{ playbackScreen: true },
	]);
	expect(seen).toEqual([true, false]);
	const asked = await app.request(path, { headers: auth });
	expect([asked.status, await asked.json()]).toEqual([
		200,
		{ playbackScreen: true },
	]);
	const leaving = JSON.stringify({
		revision: 4,
		active: false,
		sentAt: Date.now(),
		leaving: true,
	});
	expect(await answer(leaving)).toEqual([200, { playbackScreen: false }]);
	expect(
		(
			await app.request("/api/inference/screen/not-a-uuid", {
				method: "PUT",
				headers: auth,
				body: update(1, true),
			})
		).status,
	).toBe(400);
});
