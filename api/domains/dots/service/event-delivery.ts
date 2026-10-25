import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	Webhook,
	eventName,
	type WebhookPost,
} from "../../../../packages/dots-mcp/src";
import type { HandlerDefinition } from "../../queue";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Command } from "../contracts";
import * as repo from "../repository";
import { currentMessage } from "./messaging-state";
export type Subscription = {
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
export const readSubscription = (db: Database, owner: string) => {
	const r = db
		.query("SELECT data_json FROM dots_subscriptions WHERE connection_ref=?")
		.get(owner) as { data_json: string } | null;
	return r ? (JSON.parse(r.data_json) as Subscription) : null;
};
export const subscriptionHeaders = (
	s: Subscription,
	id: string,
	body: string,
	now: () => number,
	unseal: (s: string, owner: string) => string,
) => {
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
export function createDeliveryHandler(input: {
	store: SqliteStore;
	post: WebhookPost;
	now: () => number;
	unseal: (s: string, owner: string) => string;
}) {
	const { store, post, now, unseal } = input;
	const handler: HandlerDefinition<
		Payload,
		{
			s: Subscription;
			c: Command;
			id: string;
			body: string;
			httpStatus?: number;
		},
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
				s = c ? readSubscription(db, c.connectionRef) : null;
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
			if (c.kind === "message") {
				try {
					currentMessage(db, c.connectionRef, c, now());
				} catch {
					return { status: "stale", reason: "dots_delivery_stale" };
				}
			}
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
			const current = store.readSnapshot((db) => {
				if (p.c.kind === "message")
					currentMessage(db, p.c.connectionRef, p.c, now());
				return {
					s: readSubscription(db, p.s.owner),
					c: repo.command(db, p.c.commandId),
					enabled: repo.connection(db, p.s.owner)?.enabled,
				};
			});
			if (
				!current.s ||
				current.s.revision !== p.s.revision ||
				current.s.expiresAt <= now() ||
				!current.c ||
				current.c.expiresAt <= now() ||
				["superseded", "reported"].includes(current.c.state) ||
				(!current.enabled && p.c.kind !== "stop")
			)
				throw new Error("dots_delivery_stale");
			const r = await post(
				p.s.url,
				p.body,
				subscriptionHeaders(p.s, p.id, p.body, now, unseal),
				AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
			);
			p.httpStatus = r.status;
			if (r.status < 200 || r.status >= 300)
				throw new Error(
					r.status === 408 || r.status === 429 || r.status >= 500
						? "dots_delivery_retry"
						: "dots_delivery_rejected",
				);
			return r.status;
		},
		classify: (e) =>
			e instanceof Error &&
			["dots_delivery_rejected", "dots_delivery_stale"].includes(e.message)
				? "fail"
				: "retry",
		settleInTransaction(db, _claim, p, outcome) {
			if (!p) return "stale";
			if (readSubscription(db, p.s.owner)?.revision !== p.s.revision)
				return "stale";
			db.query(
				"INSERT INTO dots_deliveries VALUES(?,?,?) ON CONFLICT(command_id) DO UPDATE SET data_json=excluded.data_json",
			).run(
				p.id,
				p.c.commandId,
				JSON.stringify({
					eventId: p.id,
					state: outcome.type === "success" ? "delivered" : outcome.type,
					httpStatus:
						outcome.type === "success"
							? outcome.result
							: (p.httpStatus ?? null),
					...(outcome.type === "failed" || outcome.type === "retry"
						? { reason: outcome.errorCode }
						: {}),
				}),
			);
			return "applied";
		},
		cancelInTransaction() {},
	};

	return handler;
}
