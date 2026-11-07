import { afterEach, expect, test } from "bun:test";
import { setup, until } from "./live.fixture";
import type { LiveOutputOrigin } from "../contracts";

const open: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
const origin = (id: string, source = "A"): LiveOutputOrigin => ({
	id,
	ordinal: 0,
	input: { sources: [source], complete: true },
});

test("a proposal is checked, offered once, and a retry with different inputs is rejected", async () => {
	let current = true;
	const h = await setup({ validateProposal: () => current });
	open.push(h);
	await h.start();
	const input = origin("proposal-1");
	await h.store.write((db) => {
		expect(
			h.service.proposeInTransaction(db, "main", "考えを一つ", input),
		).toBe(true);
		expect(
			h.service.proposeInTransaction(db, "main", "考えを一つ", input),
		).toBe(true);
	});
	await until(() =>
		h.peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	await h.store.write((db) =>
		h.service.proposeInTransaction(db, "main", "考えを一つ", input),
	);
	await Bun.sleep(10);
	expect(
		h.peer.sent.filter((e) => e.type === "session.commentary.append"),
	).toHaveLength(1);
	await expect(
		h.store.write((db) =>
			h.service.proposeInTransaction(db, "main", "別の考え", input),
		),
	).rejects.toThrow("live_proposal_conflict");
	current = false;
	await expect(
		h.store.write((db) =>
			h.service.proposeInTransaction(
				db,
				"main",
				"古い前提",
				origin("proposal-2"),
			),
		),
	).rejects.toThrow("live_proposal_stale");
});

test("new voice input invalidates a queued proposal before the provider sees it", async () => {
	const h = await setup();
	open.push(h);
	const id = await h.start();
	await h.store.write((db) => {
		h.service.proposeInTransaction(db, "main", "古い提案", origin("old"));
		db.query(
			"UPDATE live_voice_sessions SET input_version=input_version+1 WHERE id=?",
		).run(id);
	});
	await until(() =>
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT text FROM live_voice_outputs WHERE origin_key='old'")
						.get() as { text: string }
				).text === "",
		),
	);
	expect(
		h.peer.sent.filter((e) => e.type === "session.commentary.append"),
	).toHaveLength(0);
});

test("a source changing during the delivery claim prevents sending and removes the saved proposal", async () => {
	let current = true;
	const h = await setup({ validateProposal: () => current });
	open.push(h);
	await h.start();
	const unbind = h.store.onCommit(() => {
		if (
			h.store.read(
				(db) =>
					!!db
						.query(
							"SELECT 1 FROM live_voice_outputs WHERE origin_key='raced' AND sent=1",
						)
						.get(),
			)
		)
			current = false;
	});
	try {
		await h.store.write((db) =>
			h.service.proposeInTransaction(
				db,
				"main",
				"送ってはいけない",
				origin("raced"),
			),
		);
		await until(() =>
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT text FROM live_voice_outputs WHERE origin_key='raced'",
							)
							.get() as { text: string }
					).text === "",
			),
		);
		expect(
			h.peer.sent.filter((e) => e.type === "session.commentary.append"),
		).toHaveLength(0);
	} finally {
		unbind();
	}
});

test("only history actually presented is tracked, and independent forgetting leaves Live running", async () => {
	const h = await setup({
		history: () => [
			{
				role: "user",
				text: "Aの古い話",
				input: { sources: ["A"], complete: true },
			},
			{
				role: "user",
				text: "B".repeat(7000),
				input: { sources: ["B"], complete: true },
			},
		],
	});
	open.push(h);
	const id = await h.start();
	const sent = JSON.stringify(
		h.peer.sent.find((e) => e.type === "session.start"),
	);
	expect(sent).not.toContain("sources");
	expect(sent).not.toContain("Aの古い話");
	await h.store.write((db) => h.service.purgeSourcesInTransaction(db, ["A"]));
	expect(h.service.state(id)?.status).toBe("active");
	await h.store.write((db) =>
		h.service.proposeInTransaction(db, "main", "Aを使う提案", origin("used-a")),
	);
	await until(() =>
		h.peer.sent.some((e) => e.type === "session.commentary.append"),
	);
	await h.store.write((db) => h.service.purgeSourcesInTransaction(db, ["A"]));
	expect(h.service.state(id)?.status).toBe("interrupted");
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query(
							"SELECT text FROM live_voice_outputs WHERE origin_key='used-a'",
						)
						.get() as { text: string }
				).text,
		),
	).toBe("");
});

test("forgetting also removes proposals and derived transcript copies from a closed session", async () => {
	const h = await setup({
		history: () => [
			{ role: "user", text: "A", input: { sources: ["A"], complete: true } },
		],
	});
	open.push(h);
	const id = await h.start();
	h.peer.event({
		type: "session.output_transcript.delta",
		delta: "Aからの発話",
		start_ms: 0,
		end_ms: 20,
	});
	h.peer.event({ type: "session.closed", usage: { duration: 1 } });
	await until(() => h.service.state(id)?.status === "closed");
	await h.store.write((db) => h.service.purgeSourcesInTransaction(db, ["A"]));
	expect(h.service.state(id)?.status).toBe("closed");
	expect(h.service.state(id)?.segments.map((s) => s.text)).toEqual([""]);
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query("SELECT delta FROM live_voice_fragments WHERE session_id=?")
						.get(id) as { delta: string }
				).delta,
		),
	).toBe("");
});

test("expiry or policy changes during a session reject late provider speech", async () => {
	let current = true;
	const h = await setup({ validInput: () => current });
	open.push(h);
	const id = await h.start();
	current = false;
	h.peer.event({
		type: "session.output_transcript.delta",
		delta: "古い前提の声",
		start_ms: 0,
		end_ms: 20,
	});
	await until(() => h.service.state(id)?.status === "interrupted");
	expect(h.service.state(id)?.segments).toHaveLength(0);
});
