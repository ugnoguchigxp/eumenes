import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerAgency } from "./routes";
import { exchange, harness } from "./host.fixture";
import { settle } from "../../infrastructure/wait-for";

test("attention and read-only status expose no conversation or memory contents", async () => {
	const h = harness({ persistent: true });
	const app = new Hono();
	registerAgency(app, h.host);
	const before = await (
		await app.request("/api/agency/conversations/screen/status")
	).json();
	expect(before.tracked).toBe(false);
	expect(h.host.inspect("screen")).toBeNull();
	await exchange(h, 1, "screen");
	await settle();
	const prior = h.host.inspect("screen")!.idle;
	const response = await app.request(
		"/api/agency/conversations/screen/attention",
		{ method: "POST" },
	);
	expect(response.status).toBe(200);
	const shown = await response.json();
	expect(shown).toMatchObject({
		activeConversationId: "screen",
		displayedConversationId: "screen",
		tracked: true,
	});
	expect(shown.idle).toEqual(prior);
	expect(JSON.stringify(shown)).not.toContain("こんにちは");
	expect(h.conversation.get("screen").messages).toHaveLength(2);
	const bad = await app.request(
		`/api/agency/conversations/${"x".repeat(161)}/attention`,
		{ method: "POST" },
	);
	expect(bad.status).toBe(400);
	expect(h.host.status("screen").activeConversationId).toBe("screen");
});

test("thoughts are served per conversation; a host without them shows none", async () => {
	const host = {
		status: () => ({}) as never,
		attend: async () => ({}) as never,
		thoughts: (id: string) =>
			id === "ao"
				? [
						{
							id: "t1",
							at: 1,
							kind: "plan" as const,
							text: "調べる: 天気（予定）",
						},
					]
				: [],
	};
	const app = new Hono();
	registerAgency(app, host);
	const shown = await (
		await app.request("/api/agency/conversations/ao/thoughts")
	).json();
	expect(shown).toEqual({
		thoughts: [{ id: "t1", at: 1, kind: "plan", text: "調べる: 天気（予定）" }],
	});
	const plain = new Hono();
	registerAgency(plain, { status: host.status, attend: host.attend });
	expect(
		await (await plain.request("/api/agency/conversations/ao/thoughts")).json(),
	).toEqual({ thoughts: [] });
	const bad = await app.request(
		`/api/agency/conversations/${"x".repeat(161)}/thoughts`,
	);
	expect(bad.status).toBe(400);
});
