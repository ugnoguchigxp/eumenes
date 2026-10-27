import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { answerError } from "../../../application/app";
import { INTERACTION_POLICY, registerCommandInteractions } from "..";
import { setup, type Harness } from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});
test("the HTTP routes answer, list and cancel interactions with the documented statuses", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const app = new Hono();
	app.onError(answerError);
	registerCommandInteractions(app, h.dialogue);
	const post = (path: string, body: unknown) =>
		app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const answer = (over: Record<string, unknown> = {}) => ({
		eventId: crypto.randomUUID(),
		questionId: interaction.question!.questionId,
		expectedRevision: 0,
		input: { durationSeconds: 90 },
		...over,
	});
	const base = `/api/toolchain-interactions/${interaction.id}`;

	expect((await app.request("/api/toolchain-interactions")).status).toBe(400);
	expect(
		(
			await app.request(
				"/api/toolchain-interactions?conversationId=main&status=nope",
			)
		).status,
	).toBe(400);
	const listed = await app.request(
		"/api/toolchain-interactions?conversationId=main&status=waiting_input",
	);
	expect(listed.status).toBe(200);
	expect(
		((await listed.json()) as Array<{ id: string }>).map((i) => i.id),
	).toEqual([interaction.id]);
	expect((await app.request(base)).status).toBe(200);
	expect(
		(await app.request(`/api/toolchain-interactions/${crypto.randomUUID()}`))
			.status,
	).toBe(404);

	expect((await post(`${base}/answers`, { nonsense: true })).status).toBe(400);
	expect(
		(await post(`${base}/answers`, answer({ input: { durationSeconds: 0 } })))
			.status,
	).toBe(422);
	expect(
		(await post(`${base}/answers`, answer({ expectedRevision: 9 }))).status,
	).toBe(409);
	expect(
		(
			await post(
				`/api/toolchain-interactions/${crypto.randomUUID()}/answers`,
				answer(),
			)
		).status,
	).toBe(404);
	const body = answer();
	const accepted = await post(`${base}/answers`, body);
	expect(accepted.status).toBe(202);
	const result = (await accepted.json()) as {
		runId: string;
		replay: boolean;
		interaction: { status: string };
	};
	expect(result).toMatchObject({
		replay: false,
		interaction: { status: "ready" },
	});
	const replay = await post(`${base}/answers`, body);
	expect(replay.status).toBe(200);
	expect(((await replay.json()) as { runId: string }).runId).toBe(result.runId);
	expect((await post(`${base}/answers`, answer())).status).toBe(409);

	expect((await post(`${base}/cancel`, { eventId: "x" })).status).toBe(400);
	const cancelled = await post(`${base}/cancel`, {
		eventId: crypto.randomUUID(),
		expectedRevision: 1,
	});
	expect(cancelled.status).toBe(200);
	expect(((await cancelled.json()) as { status: string }).status).toBe(
		"cancelled",
	);
});
test("the HTTP answer to an expired question is 410", async () => {
	h = await setup();
	await h.asked();
	const interaction = h.interaction()!;
	const app = new Hono();
	app.onError(answerError);
	registerCommandInteractions(app, h.dialogue);
	h.state.offset = INTERACTION_POLICY.answerTtlMs + 60_000;
	const response = await app.request(
		`/api/toolchain-interactions/${interaction.id}/answers`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				eventId: crypto.randomUUID(),
				questionId: interaction.question!.questionId,
				expectedRevision: 0,
				input: { durationSeconds: 60 },
			}),
		},
	);
	expect(response.status).toBe(410);
});
