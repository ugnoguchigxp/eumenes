import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Webhook, type WebhookPost } from "../../../../packages/dots-mcp/src";
import { createEvents, createSecretBox } from "..";
import * as repo from "../repository";
import { connect, fileStore, makeCommand, type FileStore } from "./support";
import { waitFor as until } from "../../../infrastructure/wait-for";

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
type Sent = {
	url: string;
	body: string;
	headers: Record<string, string>;
	signal: AbortSignal;
};

function setup(
	respond?: (sent: Sent) => ReturnType<WebhookPost>,
	now?: () => number,
) {
	const fs: FileStore = fileStore();
	closers.push(async () => {
		await fs.queue.close(100).catch(() => {});
		await fs.close();
	});
	const box = createSecretBox(join(fs.dir, "keys"));
	const sent: Sent[] = [];
	const post: WebhookPost = (url, body, headers, signal) => {
		const item = { url, body, headers, signal };
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
		now,
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
		httpStatus: 403,
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

test("unsubscribe accepts the original URL after canonicalization", async () => {
	const h = setup();
	await h.connection();
	const url = "https://HOOKS.example:443/a";
	await h.events.subscribe("conn", subscription(url));
	expect(await h.events.unsubscribe("conn", url)).toEqual({});
	expect(h.events.status("conn").subscribed).toBe(false);
});

test("refreshing the replacement key preserves the original rotation window", async () => {
	const h = setup();
	await h.connection();
	const a = secret(),
		b = secret();
	await h.events.subscribe("conn", subscription(URL_A, a));
	await h.events.subscribe("conn", subscription(URL_A, b));
	await h.events.subscribe("conn", subscription(URL_A, b));
	await h.save();
	h.queue.start();
	await until(() => h.sent.some((x) => JSON.parse(x.body).eventId));
	const d = h.sent.find((x) => JSON.parse(x.body).eventId)!;
	expect(() => new Webhook(a).verify(d.body, d.headers)).not.toThrow();
	expect(() => new Webhook(b).verify(d.body, d.headers)).not.toThrow();
});

test("receiver rejection preserves its HTTP status and never retries 410 or 413", async () => {
	for (const status of [403, 410, 413]) {
		const h = setup(async (sent) => {
			const p = JSON.parse(sent.body);
			return p.type === "verification"
				? {
						status: 200,
						body: JSON.stringify({ challenge: p.challenge }),
						retryAfter: null,
					}
				: { status, body: "", retryAfter: null };
		});
		await h.connection();
		await h.events.subscribe("conn", subscription(URL_A));
		await h.save();
		h.queue.start();
		await until(() =>
			h.store.read((db) => !!db.query("SELECT 1 FROM dots_deliveries").get()),
		);
		const r = h.store.read((db) =>
			db.query("SELECT data_json d FROM dots_deliveries").get(),
		) as { d: string };
		expect(JSON.parse(r.d)).toMatchObject({
			state: "failed",
			httpStatus: status,
		});
		expect(h.sent).toHaveLength(2);
	}
});

test("unsubscribe cancels queued deliveries and aborts an active request", async () => {
	const h = setup(async (sent) => {
		const p = JSON.parse(sent.body);
		if (p.type === "verification")
			return {
				status: 200,
				body: JSON.stringify({ challenge: p.challenge }),
				retryAfter: null,
			};
		return new Promise((_, reject) => {
			sent.signal.addEventListener("abort", () => reject(sent.signal.reason), {
				once: true,
			});
		});
	});
	await h.connection();
	await h.events.subscribe("conn", subscription(URL_A));
	await h.save();
	h.queue.start();
	await until(() => h.sent.length === 2);
	await h.events.unsubscribe("conn", URL_A);
	expect(h.sent[1]!.signal.aborted).toBe(true);
	await until(() => h.jobs()[0]?.state === "cancelled");
	const queued = setup();
	await queued.connection();
	await queued.events.subscribe("conn", subscription(URL_A));
	await queued.save();
	await queued.events.unsubscribe("conn", URL_A);
	expect(queued.jobs()[0]?.state).toBe("cancelled");
	expect(queued.sent).toHaveLength(1);
});

test("429 and 5xx retry the same event and payload with a renewed signature timestamp", async () => {
	for (const status of [429, 503]) {
		let at = Date.now(),
			attempt = 0;
		const key = secret();
		const h = setup(
			async (s) => {
				const p = JSON.parse(s.body);
				if (p.type === "verification")
					return {
						status: 200,
						body: JSON.stringify({ challenge: p.challenge }),
						retryAfter: null,
					};
				return {
					status: attempt++ === 0 ? status : 200,
					body: "{}",
					retryAfter: null,
				};
			},
			() => at,
		);
		await h.connection();
		await h.events.subscribe("conn", subscription(URL_A, key));
		await h.save();
		h.queue.start();
		await until(() => h.jobs()[0]?.state === "retry_wait");
		expect(
			h.store.read((db) =>
				JSON.parse(
					(
						db.query("SELECT data_json d FROM dots_deliveries").get() as {
							d: string;
						}
					).d,
				),
			),
		).toMatchObject({ state: "retry", httpStatus: status });
		at += 1000;
		await h.store.write((db) =>
			db
				.query(
					"UPDATE queue_jobs SET available_at_ms=0 WHERE state='retry_wait'",
				)
				.run(),
		);
		h.queue.wake();
		await until(() => h.jobs()[0]?.state === "completed");
		const [first, second] = h.sent.filter((s) => !!JSON.parse(s.body).eventId);
		expect(second!.body).toBe(first!.body);
		expect(second!.headers["webhook-id"]).toBe(first!.headers["webhook-id"]);
		expect(second!.headers["webhook-timestamp"]).not.toBe(
			first!.headers["webhook-timestamp"],
		);
		expect(() =>
			new Webhook(key).verify(second!.body, second!.headers),
		).not.toThrow();
	}
});
