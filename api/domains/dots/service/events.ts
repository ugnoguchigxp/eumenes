import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

import { z } from "zod";
import {
	Webhook,
	eventName,
	subscribeSchema,
	publicHttpsPost,
	type WebhookPost,
} from "../../../../packages/dots-mcp/src";
import type { QueueService, HandlerDefinition } from "../../queue";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Command } from "../contracts";
import * as repo from "../repository";

type Subscription = {
	id: string;
	owner: string;
	url: string;
	sealed: string;
	previous: string | null;
	rotateUntil: number;
	revision: number;
	expiresAt: number;
	verifiedKey: string;
	verifiedUntil: number;
};
type Payload = { commandId: string; revision: number };
const read = (db: Database, owner: string) => {
	const r = db
		.query("SELECT data_json FROM dots_subscriptions WHERE connection_ref=?")
		.get(owner) as { data_json: string } | null;
	return r ? (JSON.parse(r.data_json) as Subscription) : null;
};
export function createEvents(input: {
	store: SqliteStore;
	queue: QueueService;
	seal: (s: string, owner: string) => string;
	unseal: (s: string, owner: string) => string;
	post?: WebhookPost;
	now?: () => number;
}) {
	const { store, queue, seal, unseal } = input,
		now = input.now ?? Date.now,
		post = input.post ?? publicHttpsPost;
	function enqueue(db: Database, c: Command) {
		const s = read(db, c.connectionRef);
		if (
			!s ||
			s.expiresAt <= now() ||
			c.expiresAt <= now() ||
			c.state === "superseded" ||
			c.state === "reported"
		)
			return;
		try {
			queue.enqueueInTransaction(db, {
				scope: `dots:${s.owner}`,
				kind: "dots.event.v1",
				payload: { commandId: c.commandId, revision: s.revision },
				dedupeKey: `${c.commandId}:${s.revision}:${c.expiresAt}`,
				subjectRef: c.taskId,
				lane: "background",
				concurrencyKey: `dots:${s.owner}`,
				deadlineAtMs: Math.min(c.expiresAt, s.expiresAt),
				maxAttempts: 5,
			});
		} catch (e) {
			if (!(e instanceof Error) || e.message !== "queue_full") throw e;
			// The command is durable. Maintenance retries enqueueing without rolling back a stop.
		}
	}
	const headers = (s: Subscription, id: string, body: string) => {
		const at = new Date(now());
		return {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
			"webhook-signature":
				new Webhook(unseal(s.sealed, s.owner)).sign(id, at, body) +
				(s.previous && s.rotateUntil > now()
					? " " + new Webhook(unseal(s.previous, s.owner)).sign(id, at, body)
					: ""),
			"X-MCP-Subscription-Id": s.id,
		};
	};
	const handler: HandlerDefinition<
		Payload,
		{ s: Subscription; c: Command; id: string; body: string },
		number
	> = {
		kind: "dots.event.v1",
		payloadVersions: [1],
		schema: z.strictObject({
			commandId: z.string(),
			revision: z.number().int().positive(),
		}),
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const c = repo.command(db, claim.payload.commandId),
				s = c ? read(db, c.connectionRef) : null;
			if (
				!c ||
				!s ||
				s.revision !== claim.payload.revision ||
				s.expiresAt <= now() ||
				c.expiresAt <= now() ||
				["superseded", "reported"].includes(c.state) ||
				(!repo.connection(db, s.owner)?.enabled && c.kind !== "stop")
			)
				return { status: "stale", reason: "dots_delivery_stale" };
			const id = `evt_${claim.jobId}`,
				body = JSON.stringify({
					eventId: id,
					name: eventName,
					timestamp: new Date(c.createdAt).toISOString(),
					data: { command_id: c.commandId, queue_id: "eumenes-dots" },
					cursor: null,
				});
			return { status: "ready", input: { s, c, id, body } };
		},
		async execute(p, ctx) {
			const r = await post(
				p.s.url,
				p.body,
				headers(p.s, p.id, p.body),
				AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
			);
			if (r.status < 200 || r.status >= 300)
				throw new Error(
					r.status === 408 || r.status === 429 || r.status >= 500
						? "dots_delivery_retry"
						: "dots_delivery_rejected",
				);
			return r.status;
		},
		classify: (e) =>
			e instanceof Error && e.message === "dots_delivery_rejected"
				? "fail"
				: "retry",
		settleInTransaction(db, _claim, p, outcome) {
			if (!p) return "stale";
			if (read(db, p.s.owner)?.revision !== p.s.revision) return "stale";
			db.query(
				"INSERT INTO dots_deliveries VALUES(?,?,?) ON CONFLICT(command_id) DO UPDATE SET data_json=excluded.data_json",
			).run(
				p.id,
				p.c.commandId,
				JSON.stringify({
					eventId: p.id,
					state: outcome.type === "success" ? "delivered" : outcome.type,
					httpStatus: outcome.type === "success" ? outcome.result : null,
				}),
			);
			return "applied";
		},
		cancelInTransaction() {},
	};
	queue.registerHandler(handler);
	return {
		enqueueInTransaction: enqueue,
		async maintenance() {
			await store.write((db) => {
				const owners = db
					.query("SELECT connection_ref FROM dots_subscriptions")
					.all() as { connection_ref: string }[];
				for (const { connection_ref } of owners)
					for (const { command } of repo.commands(
						db,
						connection_ref,
						0,
						4096,
					)) {
						if (
							repo.connection(db, connection_ref)?.enabled ||
							command.kind === "stop"
						)
							enqueue(db, command);
					}
			});
			queue.wake();
		},
		status(owner: string) {
			return store.readSnapshot((db) => {
				const s = read(db, owner);
				return {
					subscribed: !!s && s.expiresAt > now(),
					expiresAt: s?.expiresAt ?? null,
				};
			});
		},
		async subscribe(owner: string, raw: unknown) {
			const data = subscribeSchema.parse(raw),
				u = new URL(data.delivery.url);
			const secretBytes = Buffer.from(data.delivery.secret.slice(6), "base64");
			if (
				u.protocol !== "https:" ||
				u.username ||
				u.password ||
				u.hash ||
				secretBytes.length < 24 ||
				secretBytes.length > 64 ||
				secretBytes.toString("base64").replace(/=+$/, "") !==
					data.delivery.secret.slice(6).replace(/=+$/, "")
			)
				throw new Error("invalid_dots_subscription");
			const old = store.readSnapshot((db) => read(db, owner));
			if (old && old.expiresAt > now() && old.url !== u.href)
				throw new Error("dots_conflict");
			const verifiedKey = createHash("sha256")
				.update(JSON.stringify([owner, u.href, data.delivery.secret]))
				.digest("hex");
			const cached =
				old?.verifiedKey === verifiedKey && old.verifiedUntil > now();
			const s: Subscription = {
				id:
					"sub_" +
					createHash("sha256")
						.update(
							JSON.stringify([
								owner,
								u.href,
								eventName,
								{ queue_id: "eumenes-dots" },
							]),
						)
						.digest("hex"),
				owner,
				verifiedKey,
				verifiedUntil: cached ? old!.verifiedUntil : now() + 600000,
				url: u.href,
				sealed: seal(data.delivery.secret, owner),
				previous: old?.sealed ?? null,
				rotateUntil: now() + 60000,
				revision: (old?.revision ?? 0) + 1,
				expiresAt: now() + Math.min(data.ttlMs ?? 3600000, 86400000),
			};
			if (!cached) {
				const challenge = randomBytes(32).toString("base64url"),
					body = JSON.stringify({ type: "verification", challenge }),
					id = `msg_verification_${crypto.randomUUID()}`;
				const response = await post(
					s.url,
					body,
					headers(s, id, body),
					AbortSignal.timeout(10000),
				).catch((e: unknown) => {
					throw new Error(
						e instanceof Error &&
							["TimeoutError", "AbortError"].includes(e.name)
							? "dots_callback_timeout"
							: "dots_callback_unavailable",
					);
				});
				let echoed: unknown;
				try {
					echoed = JSON.parse(response.body).challenge;
				} catch {
					throw new Error("invalid_dots_challenge");
				}
				if (
					response.status < 200 ||
					response.status >= 300 ||
					typeof echoed !== "string" ||
					Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
					!timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
				)
					throw new Error("invalid_dots_challenge");
			}
			await store.write((db) => {
				if (
					!repo.connection(db, owner)?.enabled &&
					!repo
						.commands(db, owner, 0, 4096)
						.some(
							({ command }) =>
								command.kind === "stop" && command.expiresAt > now(),
						)
				)
					throw new Error("dots_unavailable");
				if ((read(db, owner)?.revision ?? 0) !== (old?.revision ?? 0))
					throw new Error("dots_conflict");
				db.query(
					"INSERT INTO dots_subscriptions VALUES(?,?) ON CONFLICT(connection_ref) DO UPDATE SET data_json=excluded.data_json",
				).run(owner, JSON.stringify(s));
				for (const { command } of repo.commands(db, owner, 0, 4096))
					enqueue(db, command);
			});
			queue.wake();
			return {
				id: s.id,
				refreshBefore: new Date(s.expiresAt).toISOString(),
				cursor: null,
				truncated: false,
			};
		},
		async unsubscribe(owner: string, url: string) {
			return store.write((db) => {
				const s = read(db, owner);
				if (s && s.url !== url) throw new Error("dots_conflict");
				if (s) {
					s.expiresAt = now();
					s.revision++;
					db.query(
						"UPDATE dots_subscriptions SET data_json=? WHERE connection_ref=?",
					).run(JSON.stringify(s), owner);
				}
				return {};
			});
		},
	};
}
