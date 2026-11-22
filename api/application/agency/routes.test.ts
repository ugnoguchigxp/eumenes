import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerAgency } from "./routes";
import { agendaFixture } from "./always-on.fixture";

test("attention and read-only status expose no conversation or memory contents", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		const app = new Hono();
		registerAgency(app, f.host);
		const before = await (
			await app.request("/api/agency/conversations/screen/status")
		).json();
		expect(before.tracked).toBe(false);
		expect(f.host.inspect("screen")).toBeNull();
		await f.user("u1", "screen", "こんにちは");
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
		expect(JSON.stringify(shown)).not.toContain("こんにちは");
		expect(f.h.conversation.get("screen").messages).toHaveLength(1);
		const bad = await app.request(
			`/api/agency/conversations/${"x".repeat(161)}/attention`,
			{ method: "POST" },
		);
		expect(bad.status).toBe(400);
		expect(f.host.status("screen").activeConversationId).toBe("screen");
	} finally {
		await f.close();
	}
});

test("thoughts are served per conversation", async () => {
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
	expect(
		await (
			await app.request("/api/agency/conversations/other/thoughts")
		).json(),
	).toEqual({ thoughts: [] });
	const bad = await app.request(
		`/api/agency/conversations/${"x".repeat(161)}/thoughts`,
	);
	expect(bad.status).toBe(400);
});
