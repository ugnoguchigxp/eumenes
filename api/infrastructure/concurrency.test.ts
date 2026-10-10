import { expect, test } from "bun:test";
import { Hono } from "hono";
import { limitConcurrency } from "./concurrency";

test("requests above the limit get 429 and slots are released", async () => {
	const release: Array<() => void> = [];
	const app = new Hono();
	app.use("/slow", limitConcurrency(2));
	app.post(
		"/slow",
		(c) =>
			new Promise<Response>((resolve) =>
				release.push(() => resolve(c.json({ ok: true }))),
			),
	);
	const send = () => app.request("/slow", { method: "POST" });
	const first = send();
	const second = send();
	await Promise.resolve();
	const third = await send();
	expect(third.status).toBe(429);
	expect(await third.json()).toEqual({ error: "too_many_requests" });
	for (const done of release.splice(0)) done();
	expect((await first).status).toBe(200);
	expect((await second).status).toBe(200);
	const fourth = send();
	await Promise.resolve();
	release.splice(0).forEach((done) => done());
	expect((await fourth).status).toBe(200);
});

test("a failing handler still releases its slot", async () => {
	const app = new Hono();
	app.use("*", limitConcurrency(1));
	app.get("/boom", () => {
		throw new Error("boom");
	});
	expect((await app.request("/boom")).status).toBe(500);
	expect((await app.request("/boom")).status).toBe(500);
});
