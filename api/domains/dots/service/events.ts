import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

import {
	createDeliveryHandler,
	subscriptionHeaders,
	readSubscription as read,
	type Subscription,
} from "./event-delivery";
import {
	eventName,
	subscribeSchema,
	publicHttpsPost,
	type WebhookPost,
} from "../../../../packages/dots-mcp/src";
import type { QueueService } from "../../queue";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Command } from "../contracts";
import * as repo from "../repository";

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
				subjectRef:
					c.kind === "message" ? `dots-message:${c.messageId}` : c.taskId,
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
	/** Whether the connection's dots delivery subscription is registered and unexpired. */
	function statusInTransaction(db: Database, owner: string) {
		const s = read(db, owner);
		return {
			subscribed: !!s && s.expiresAt > now(),
			expiresAt: s?.expiresAt ?? null,
		};
	}
	const headers = (s: Subscription, id: string, body: string) =>
		subscriptionHeaders(s, id, body, now, unseal);
	const handler = createDeliveryHandler({ store, post, now, unseal });
	queue.registerHandler(handler);
	return {
		enqueueInTransaction: enqueue,
		wake: () => queue.wake(),
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
		statusInTransaction,
		status: (owner: string) =>
			store.readSnapshot((db) => statusInTransaction(db, owner)),
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
				previous:
					old && unseal(old.sealed, owner) !== data.delivery.secret
						? old.sealed
						: (old?.previous ?? null),
				rotateUntil:
					old && unseal(old.sealed, owner) !== data.delivery.secret
						? now() + 60000
						: (old?.rotateUntil ?? 0),
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
			const jobs: string[] = [];
			const result = await store.write((db) => {
				const s = read(db, owner);
				if (s && s.url !== new URL(url).href) throw new Error("dots_conflict");
				if (s) {
					for (const { command: c } of repo.commands(db, owner, 0, 4096)) {
						const job = queue.findByDedupeInTransaction(
							db,
							`dots:${owner}`,
							"dots.event.v1",
							`${c.commandId}:${s.revision}:${c.expiresAt}`,
						);
						if (job) {
							queue.cancelInTransaction(db, job.id, "dots_unsubscribed");
							jobs.push(job.id);
						}
					}
					s.expiresAt = now();
					s.revision++;
					db.query(
						"UPDATE dots_subscriptions SET data_json=? WHERE connection_ref=?",
					).run(JSON.stringify(s), owner);
				}
				return {};
			});
			queue.flushCancellations(jobs);
			return result;
		},
	};
}
