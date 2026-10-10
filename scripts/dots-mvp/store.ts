import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { openSync, closeSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ContractError, EVENT, QUEUE, type RequestRecord } from "./contracts";
import { stateSecrets } from "./private-state";

export type Subscription = {
	id: string;
	owner: string;
	url: string;
	secret: string;
	previous: string | null;
	rotateUntil: number;
	expires: number;
	verified: number;
	active: number;
};
type StoredSubscription = Omit<Subscription, "secret" | "previous"> & {
	secret: string;
	previous: string | null;
};
type RequestRow = {
	id: string;
	text: string;
	created: number;
	deadline: number;
	state: RequestRecord["state"];
	answer: string | null;
	receipt: string | null;
	saved: number | null;
};
export type DeliveryRow = {
	event: string;
	request: string;
	subscription: string;
	body: string;
	state: string;
	attempts: number;
	next: number;
	status: number | null;
	reason: string | null;
};
export function subscriptionId(owner: string, url: string) {
	return `sub_${createHash("sha256")
		.update(JSON.stringify([owner, url, EVENT, { queue_id: QUEUE }]))
		.digest("hex")}`;
}

export class Store {
	readonly secrets: ReturnType<typeof stateSecrets>;
	readonly db: Database;
	private lockFd: number;
	private lockLibrary: ReturnType<
		typeof dlopen<{
			flock: {
				args: [typeof FFIType.i32, typeof FFIType.i32];
				returns: typeof FFIType.i32;
			};
		}>
	>;
	constructor(
		directory: string,
		private now: () => number = Date.now,
	) {
		this.secrets = stateSecrets(directory);
		this.lockFd = openSync(join(directory, "writer.lock"), "a", 0o600);
		this.lockLibrary = dlopen(
			process.platform === "darwin"
				? "/usr/lib/libSystem.B.dylib"
				: "libc.so.6",
			{ flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
		);
		if (this.lockLibrary.symbols.flock!(this.lockFd, 6) !== 0) {
			closeSync(this.lockFd);
			this.lockLibrary.close();
			throw new ContractError("writer_already_running");
		}
		try {
			this.db = new Database(join(directory, "state.sqlite"), {
				create: true,
				strict: true,
			});
			chmodSync(join(directory, "state.sqlite"), 0o600);
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, previous TEXT, rotateUntil INTEGER NOT NULL, expires INTEGER NOT NULL, verified INTEGER NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL, answer TEXT, receipt TEXT, saved INTEGER);
        CREATE TABLE IF NOT EXISTS deliveries (event TEXT PRIMARY KEY, request TEXT NOT NULL REFERENCES requests(id), subscription TEXT NOT NULL REFERENCES subscriptions(id), body TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, next INTEGER NOT NULL, status INTEGER, reason TEXT);
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state,next);
        CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT, status INTEGER);`);
			this.db
				.query("UPDATE deliveries SET state='pending' WHERE state='sending'")
				.run();
		} catch (e) {
			closeSync(this.lockFd);
			this.lockLibrary.close();
			throw e;
		}
	}
	close() {
		this.db.close();
		closeSync(this.lockFd);
		this.lockLibrary.close();
	}
	audit(kind: string, id: string | null = null, status: number | null = null) {
		this.db
			.query("INSERT INTO audit(at,kind,id,status) VALUES(?,?,?,?)")
			.run(this.now(), kind, id, status);
	}
	active(owner: string) {
		const row = this.db
			.query<StoredSubscription, [string, number]>(
				"SELECT * FROM subscriptions WHERE owner=? AND active=1 AND expires>? LIMIT 1",
			)
			.get(owner, this.now());
		return row ? this.decode(row) : null;
	}
	private decode(s: StoredSubscription): Subscription {
		return {
			...s,
			secret: this.secrets.decrypt(s.secret),
			previous: s.previous ? this.secrets.decrypt(s.previous) : null,
		};
	}
	subscription(id: string) {
		const s = this.db
			.query<StoredSubscription, [string]>(
				"SELECT * FROM subscriptions WHERE id=?",
			)
			.get(id);
		return s ? this.decode(s) : null;
	}
	saveSubscription(
		input: {
			owner: string;
			url: string;
			secret: string;
			ttlMs?: number | null;
		},
		verified: number,
	) {
		const { owner, url, secret } = input;
		const id = subscriptionId(owner, url);
		const current = this.active(owner);
		if (current && current.id !== id)
			throw new ContractError("another_subscription_active");
		const old = this.subscription(id);
		const expires =
			this.now() + Math.max(60000, Math.min(input.ttlMs ?? 86400000, 86400000));
		const previous =
			old && old.secret !== secret ? old.secret : (old?.previous ?? null);
		const rotateUntil =
			old && old.secret !== secret
				? this.now() + 60000
				: (old?.rotateUntil ?? 0);
		this.db
			.query(
				"INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,previous=excluded.previous,rotateUntil=excluded.rotateUntil,expires=excluded.expires,verified=excluded.verified,active=1",
			)
			.run(
				id,
				owner,
				url,
				this.secrets.encrypt(secret),
				previous ? this.secrets.encrypt(previous) : null,
				rotateUntil,
				expires,
				verified,
				1,
			);
		this.audit("subscription.active", id);
		return {
			id,
			refreshBefore: new Date(expires).toISOString(),
			cursor: null,
			truncated: false,
		};
	}
	unsubscribe(owner: string, url: string) {
		const id = subscriptionId(owner, url);
		this.db.transaction(() => {
			this.db
				.query("UPDATE subscriptions SET active=0 WHERE id=? AND owner=?")
				.run(id, owner);
			this.db
				.query(
					"UPDATE deliveries SET state='stopped',reason='unsubscribed' WHERE subscription=? AND state IN ('pending','sending')",
				)
				.run(id);
		})();
		this.audit("subscription.stopped", id);
		return {};
	}
	send(
		owner: string,
		input: { requestId: string; text: string; deadlineMs: number },
	) {
		const existing = this.db
			.query<RequestRow, [string]>("SELECT * FROM requests WHERE id=?")
			.get(input.requestId);
		if (existing) {
			if (
				existing.text !== input.text ||
				existing.deadline - existing.created !== input.deadlineMs
			)
				throw new ContractError("request_id_conflict");
			return this.get(input.requestId);
		}
		const sub = this.active(owner);
		if (!sub) throw new ContractError("not_subscribed");
		const now = this.now();
		const event = `evt_${randomUUID()}`;
		const body = JSON.stringify({
			eventId: event,
			name: EVENT,
			timestamp: new Date(now).toISOString(),
			data: {
				request_id: input.requestId,
				request_version: 1,
				queue_id: QUEUE,
			},
			cursor: null,
		});
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO requests VALUES(?,?,?,?,'pending',NULL,NULL,NULL)")
				.run(input.requestId, input.text, now, now + input.deadlineMs);
			this.db
				.query("INSERT INTO deliveries VALUES(?,?,?,?,'pending',0,?,NULL,NULL)")
				.run(event, input.requestId, sub.id, body, now);
			this.audit("request.created", input.requestId);
		})();
		return this.get(input.requestId);
	}
	get(id: string): RequestRecord {
		this.db
			.query(
				"UPDATE requests SET state='expired' WHERE id=? AND state='pending' AND deadline<=?",
			)
			.run(id, this.now());
		const r = this.db
			.query<RequestRow, [string]>("SELECT * FROM requests WHERE id=?")
			.get(id);
		if (!r) throw new ContractError("request_not_found", 404);
		const d = this.db
			.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE request=?")
			.get(id)!;
		return {
			requestId: r.id,
			requestVersion: 1,
			text: r.text,
			createdAt: new Date(r.created).toISOString(),
			deadlineAt: new Date(r.deadline).toISOString(),
			state: r.state,
			answer: r.answer
				? {
						outcome: r.state as "answered" | "failed",
						text: r.answer,
						receiptId: r.receipt!,
						savedAt: new Date(r.saved!).toISOString(),
					}
				: null,
			delivery: {
				eventId: d.event,
				state: d.state,
				attempts: d.attempts,
				status: d.status,
				reason: d.reason,
			},
		};
	}
	pending(owner: string) {
		const requests = this.db
			.query<{ requestId: string }, [string, number]>(
				"SELECT r.id AS requestId FROM requests r JOIN deliveries d ON d.request=r.id JOIN subscriptions s ON s.id=d.subscription WHERE s.owner=? AND r.state='pending' AND r.deadline>? ORDER BY r.created LIMIT 10",
			)
			.all(owner, this.now())
			.map((r) => ({ ...r, requestVersion: 1 as const }));
		this.audit("requests.listed");
		return requests;
	}
	read(owner: string, id: string) {
		this.authorize(owner, id);
		const r = this.get(id);
		if (["cancelled", "expired"].includes(r.state))
			throw new ContractError(`request_${r.state}`);
		this.audit("request.read", id);
		return r;
	}
	private authorize(owner: string, id: string) {
		const r = this.db
			.query<{ owner: string }, [string]>(
				"SELECT s.owner FROM deliveries d JOIN subscriptions s ON s.id=d.subscription WHERE d.request=?",
			)
			.get(id);
		if (!r || r.owner !== owner)
			throw new ContractError("request_not_found", 404);
	}
	answer(
		owner: string,
		input: { requestId: string; outcome: "answered" | "failed"; text: string },
	) {
		this.authorize(owner, input.requestId);
		return this.db.transaction(() => {
			const r = this.get(input.requestId);
			if (r.answer) {
				if (r.answer.text !== input.text || r.answer.outcome !== input.outcome)
					throw new ContractError("answer_conflict");
				return r.answer;
			}
			if (r.state !== "pending") throw new ContractError(`request_${r.state}`);
			const receiptId = `receipt_${randomUUID()}`;
			const saved = this.now();
			this.db
				.query(
					"UPDATE requests SET state=?,answer=?,receipt=?,saved=? WHERE id=?",
				)
				.run(input.outcome, input.text, receiptId, saved, input.requestId);
			this.audit("answer.saved", input.requestId);
			return {
				outcome: input.outcome,
				text: input.text,
				receiptId,
				savedAt: new Date(saved).toISOString(),
			};
		})();
	}
	cancel(id: string) {
		this.get(id);
		this.db.transaction(() => {
			this.db
				.query(
					"UPDATE requests SET state='cancelled' WHERE id=? AND state='pending'",
				)
				.run(id);
			this.db
				.query(
					"UPDATE deliveries SET state='stopped',reason='cancelled' WHERE request=? AND state IN ('pending','sending')",
				)
				.run(id);
		})();
		return this.get(id);
	}
	due() {
		return this.db
			.query<DeliveryRow, [number]>(
				"SELECT * FROM deliveries WHERE state='pending' AND next<=? ORDER BY next LIMIT 1",
			)
			.get(this.now());
	}
	claim(event: string) {
		this.db
			.query(
				"UPDATE deliveries SET state='sending',attempts=attempts+1 WHERE event=? AND state='pending'",
			)
			.run(event);
	}
	delivered(
		event: string,
		state: string,
		status: number | null,
		reason: string | null,
		next = 0,
	) {
		this.db
			.query(
				"UPDATE deliveries SET state=?,status=?,reason=?,next=? WHERE event=? AND state='sending'",
			)
			.run(state, status, reason, next, event);
		this.audit(`delivery.${state}`, event, status);
	}
	status(owner: string) {
		const s = this.active(owner);
		return {
			queueId: QUEUE,
			subscription: s
				? { id: s.id, expiresAt: new Date(s.expires).toISOString() }
				: null,
			requests: this.db
				.query(
					"SELECT id,state,created,deadline FROM requests ORDER BY created DESC LIMIT 20",
				)
				.all(),
			audit: this.db
				.query("SELECT at,kind,id,status FROM audit ORDER BY seq DESC LIMIT 30")
				.all(),
		};
	}
}
