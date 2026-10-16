import { expect, test } from "bun:test";
import { workersSettingsFixture } from "./workers-ai-settings.fixture";

test("registration rejects bad input without writes and saves the corrected connection through HTTP", async () => {
	const h = await workersSettingsFixture();
	try {
		const connectionId = crypto.randomUUID();
		const submit = (accountId: string, token?: string) =>
			h.app.request("/api/toolchain-actions", {
				method: "POST",
				headers: {
					authorization: "Bearer fixture-workers-api-browser-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					version: 1,
					eventId: crypto.randomUUID(),
					eventCreatedAt: new Date().toISOString(),
					eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
					artifactId: "registration-test",
					artifactRevisionId: "artifact:settings.ai-connections@7",
					source: "settings-ai",
					sourceRevision: h.settings.get().revision,
					actionId: "apply",
					scopeRef: h.ledger.scopeRef,
					input: {
						expectedRevision: h.settings.get().revision,
						changes: [],
						structural: [
							{
								structure: "structure:settings.add-connection@2",
								input: {
									connectionId,
									kind: "cloudflare-workers-ai",
									name: "Workers接続",
									accountId,
								},
							},
						],
						...(token ? { keys: [{ connectionId, value: token }] } : {}),
					},
				}),
			});
		const original = h.settings.get().revision;
		const bad = await submit("bad-account", "private-registration-token");
		expect(bad.status).toBe(422);
		expect((await bad.json()).error).toBe("invalid_input");
		const missing = await submit("a".repeat(32));
		expect((await missing.json()).errorCode).toBe("credential_required");
		expect(h.settings.get().revision).toBe(original);
		expect(h.settings.get().connections).toHaveLength(0);
		const valid = await submit("a".repeat(32), "private-registration-token");
		expect(valid.status).toBe(200);
		expect((await valid.json()).status).toBe("accepted");
		expect(h.settings.get().connections).toEqual([
			expect.objectContaining({ id: connectionId, accountId: "a".repeat(32) }),
		]);
		expect(h.settings.credential(h.settings.get().connections[0]!)).toBe(
			"private-registration-token",
		);
		expect(JSON.stringify(h.settings.get())).not.toContain(
			"private-registration-token",
		);
		expect(h.wire).toHaveLength(0);
	} finally {
		await h.close();
	}
});
