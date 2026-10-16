import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Webhook, type WebhookPost } from "../../../../packages/dots-mcp/src";
import { createEvents, createSecretBox } from "..";
import * as repo from "../repository";
import { connect, fileStore, makeCommand, type FileStore } from "./support";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
const secret = () => "whsec_" + randomBytes(32).toString("base64");
const subscription = (url: string, key = secret(), ttlMs?: number) => ({
	name: "command.available",
	arguments: { queue_id: "eumenes-dots" },
	delivery: { mode: "webhook", url, secret: key },
	...(ttlMs ? { ttlMs } : {}),
});
type Sent = { url: string; body: string; headers: Record<string, string> };
async function until(cond: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not reached");
}

function setup(respond?: (sent: Sent) => ReturnType<WebhookPost>) {
	const fs: FileStore = fileStore();
	closers.push(async () => {
		await fs.queue.close(100).catch(() => {});
		await fs.close();
	});
	const box = createSecretBox(join(fs.dir, "keys"));
	const sent: Sent[] = [];
	const post: WebhookPost = (url, body, headers) => {
		const item = { url, body, headers };
		sent.push(item);
		if (respond) return respond(item);
		const p = JSON.parse(body);
		return Promise.resolve({
			status: 200,
			body:
				p.type === "verification"
					? JSON.stringify({ challenge: p.challenge })
					: "{}",
			retryAfter: null,
		});
	};
	const events = createEvents({
		store: fs.store,
		queue: fs.queue,
		...box,
		post,
	});
	const command = (change: Parameters<typeof makeCommand>[0] = {}) =>
		makeCommand({
			createdAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
			...change,
		});
	const save = (c = command()) =>
		fs.store.write((db) => {
			repo.putCommand(db, c);
			events.enqueueInTransaction(db, c);
			return c;
		});
	const connection = () =>
		fs.store.write((db) => {
			connect(db);
		});
	const jobs = () =>
		fs.store.read(
			(db) =>
				db
					.query("SELECT state FROM queue_jobs WHERE kind='dots.event.v1'")
					.all() as Array<{ state: string }>,
		);
	return { ...fs, box, sent, events, command, save, connection, jobs };
}
const URL_A = "https://hooks.example/a";

test("subscribe verifies the callback with a signed challenge and stores the secret sealed", async () => {
	const h = setup();
	await h.connection();
	const key = secret();
	const result = await h.events.subscribe("conn", subscription(URL_A, key));
	expect(result).toMatchObject({
		id: expect.stringMatching(/^sub_[0-9a-f]{64}$/),
		cursor: null,
		truncated: false,
	});
	expect(h.sent).toHaveLength(1);
	const challenge = JSON.parse(h.sent[0]!.body);
	expect(challenge).toMatchObject({ type: "verification" });
	// The receiver can verify the signature with the secret it chose.
	expect(() =>
		new Webhook(key).verify(h.sent[0]!.body, h.sent[0]!.headers),
	).not.toThrow();
	const stored = h.store.read(
		(db) =>
			(
				db.query("SELECT data_json d FROM dots_subscriptions").get() as {
					d: string;
				}
			).d,
	);
	expect(stored).not.toContain(key.slice(6));
	expect(h.events.status("conn")).toMatchObject({ subscribed: true });
	expect(h.events.status("other")).toEqual({
		subscribed: false,
		expiresAt: null,
	});
});

test("a wrong, missing or failed challenge response rejects the subscription", async () => {
	const cases: Array<[(s: Sent) => ReturnType<WebhookPost>, string]> = [
		[
			async () => ({
				status: 200,
				body: JSON.stringify({ challenge: "wrong" }),
				retryAfter: null,
			}),
			"invalid_dots_challenge",
		],
		[
			async () => ({ status: 200, body: "not json", retryAfter: null }),
			"invalid_dots_challenge",
		],
		[
			async () => ({ status: 200, body: "{}", retryAfter: null }),
			"invalid_dots_challenge",
		],
		[
			async (s) => ({
				status: 500,
				body: JSON.stringify({ challenge: JSON.parse(s.body).challenge }),
				retryAfter: null,
			}),
			"invalid_dots_challenge",
		],
		[
			() =>
				Promise.reject(
					Object.assign(new Error("slow"), { name: "TimeoutError" }),
				),
			"dots_callback_timeout",
		],
		[() => Promise.reject(new Error("dns")), "dots_callback_unavailable"],
	];
	for (const [respond, code] of cases) {
		const h = setup(respond);
		await h.connection();
		await expect(
			h.events.subscribe("conn", subscription(URL_A)),
		).rejects.toThrow(code);
		expect(h.events.status("conn").subscribed).toBe(false);
	}
});

test("subscription input is validated before any request is made", async () => {
	const h = setup();
	await h.connection();
	const bad = [
		subscription("http://hooks.example/a"),
		subscription("https://user:pw@hooks.example/a"),
		subscription("https://hooks.example/a#frag"),
		subscription(URL_A, "whsec_" + randomBytes(8).toString("base64")),
		subscription(URL_A, "whsec_" + randomBytes(80).toString("base64")),
		{ ...subscription(URL_A), name: "other.event" },
		subscription(URL_A, secret(), 86_400_001),
	];
	for (const input of bad)
		await expect(h.events.subscribe("conn", input)).rejects.toThrow();
	expect(h.sent).toEqual([]);
});

test("a disabled connection may subscribe only while a stop is pending", async () => {
	const h = setup();
	await h.store.write((db) => {
		connect(db, "conn", { enabled: false });
	});
	await expect(h.events.subscribe("conn", subscription(URL_A))).rejects.toThrow(
		"dots_unavailable",
	);
	await h.store.write((db) => repo.putCommand(db, h.command({ kind: "stop" })));
	await h.events.subscribe("conn", subscription(URL_A));
	expect(h.events.status("conn").subscribed).toBe(true);
});

test("a live subscription cannot move to another url but can be refreshed", async () => {
	const h = setup();
	await h.connection();
	const key = secret();
	await h.events.subscribe("conn", subscription(URL_A, key));
	await expect(
		h.events.subscribe("conn", subscription("https://hooks.example/b")),
	).rejects.toThrow("dots_conflict");
	const revision = () =>
		h.store.read(
			(db) =>
				JSON.parse(
					(
						db.query("SELECT data_json d FROM dots_subscriptions").get() as {
							d: string;
						}
					).d,
				).revision,
		);
	expect(revision()).toBe(1);
	// The same secret within the verification window is not challenged again.
	await h.events.subscribe("conn", subscription(URL_A, key));
	expect(h.sent).toHaveLength(1);
	expect(revision()).toBe(2);
	// A new secret is challenged, and the previous one still signs during rotation.
	await h.events.subscribe("conn", subscription(URL_A));
	expect(h.sent).toHaveLength(2);
	expect(revision()).toBe(3);
	expect(h.sent[1]!.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
});

test("unsubscribe expires the subscription and refuses another url", async () => {
	const h = setup();
	await h.connection();
	await h.events.subscribe("conn", subscription(URL_A));
	await expect(
		h.events.unsubscribe("conn", "https://hooks.example/b"),
	).rejects.toThrow("dots_conflict");
	expect(await h.events.unsubscribe("conn", new URL(URL_A).href)).toEqual({});
	expect(h.events.status("conn").subscribed).toBe(false);
	expect(await h.events.unsubscribe("other", URL_A)).toEqual({});
});

test("a stored command is delivered with a verifiable signature and the delivery is recorded", async () => {
	const h = setup();
	await h.connection();
	const key = secret();
	await h.events.subscribe("conn", subscription(URL_A, key));
	const command = await h.save();
	expect(h.jobs()).toHaveLength(1);
	h.queue.start();
	await until(() => h.sent.length === 2);
	const delivery = h.sent[1]!;
	expect(delivery.url).toBe(new URL(URL_A).href);
	const body = JSON.parse(delivery.body);
	expect(body).toMatchObject({
		name: "command.available",
		data: { command_id: command.commandId, queue_id: "eumenes-dots" },
	});
	expect(() =>
		new Webhook(key).verify(delivery.body, delivery.headers),
	).not.toThrow();
	expect(delivery.headers["webhook-id"]).toBe(body.eventId);
	await until(
		() =>
			h.store.read(
				(db) =>
					db.query("SELECT count(*) n FROM dots_deliveries").get() as {
						n: number;
					},
			).n === 1,
	);
	const row = h.store.read(
		(db) =>
			db.query("SELECT data_json d FROM dots_deliveries").get() as {
				d: string;
			},
	);
	expect(JSON.parse(row.d)).toEqual({
		eventId: body.eventId,
		state: "delivered",
		httpStatus: 200,
	});
});

test("a receiver rejection is recorded as a failed delivery without retrying", async () => {
	const h = setup((sent) => {
		const p = JSON.parse(sent.body);
		return Promise.resolve(
			p.type === "verification"
				? {
						status: 200,
						body: JSON.stringify({ challenge: p.challenge }),
						retryAfter: null,
					}
				: { status: 403, body: "", retryAfter: null },
		);
	});
	await h.connection();
	await h.events.subscribe("conn", subscription(URL_A));
	await h.save();
	h.queue.start();
	await until(
		() =>
			h.store.read(
				(db) =>
					db.query("SELECT count(*) n FROM dots_deliveries").get() as {
						n: number;
					},
			).n === 1,
	);
	const row = h.store.read(
		(db) =>
			db.query("SELECT data_json d FROM dots_deliveries").get() as {
				d: string;
			},
	);
	expect(JSON.parse(row.d)).toMatchObject({
		state: "failed",
		httpStatus: null,
	});
	expect(h.sent).toHaveLength(2);
});

test("commands that cannot be acted on are not queued for delivery", async () => {
	const h = setup();
	await h.connection();
	// No subscription yet: nothing is queued until the receiver subscribes.
	await h.save(h.command({ commandId: "early" }));
	expect(h.jobs()).toHaveLength(0);
	await h.events.subscribe("conn", subscription(URL_A));
	expect(h.jobs()).toHaveLength(1);
	for (const change of [
		{ commandId: "gone", state: "superseded" as const },
		{ commandId: "done", state: "reported" as const },
		{ commandId: "old", expiresAt: Date.now() - 1 },
	])
		await h.save(h.command(change));
	expect(h.jobs()).toHaveLength(1);
	const expiresAt = Date.now() + 3_600_000;
	await h.save(h.command({ commandId: "live", expiresAt }));
	expect(h.jobs()).toHaveLength(2);
	// The same command with the same expiry is queued only once.
	await h.save(h.command({ commandId: "live", expiresAt }));
	expect(h.jobs()).toHaveLength(2);
});

test("maintenance queues commands that were stored before the subscription existed", async () => {
	const h = setup();
	await h.connection();
	await h.save(h.command({ commandId: "early" }));
	await h.events.subscribe("conn", subscription(URL_A));
	// subscribe already enqueued the pending command; maintenance is idempotent.
	expect(h.jobs()).toHaveLength(1);
	await h.events.maintenance();
	expect(h.jobs()).toHaveLength(1);
});
