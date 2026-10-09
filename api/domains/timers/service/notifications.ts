import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	ackNotificationSchema,
	claimNotificationSchema,
	silenceNotificationSchema,
	type TimerNotificationDto,
} from "../contracts";
import {
	claimNotification,
	expiredClaims,
	getNotification,
	listNotifications,
	releaseClaim,
	settleNotification,
	silenceClaimedStale,
	silencePending,
	stalePending,
	type NotificationRow,
} from "../repository";
import { iso } from "./canonical";
import type { TimerDeps } from "./deps";
import { notificationDto } from "./expiry";
import { TIMER_POLICY } from "./policy";

const dueCursor = z
	.object({ dueAtMs: z.number().int(), id: z.uuid() })
	.strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new Error("invalid_timer_input");
	return parsed.data;
}

function decodeDue(cursor: string | undefined) {
	if (!cursor) return null;
	try {
		const parsed = dueCursor.safeParse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
		if (!parsed.success) throw new Error("invalid_cursor");
		return parsed.data;
	} catch (error) {
		if (error instanceof Error && error.message === "invalid_cursor") throw error;
		throw new Error("invalid_cursor");
	}
}

function encodeDue(dueAtMs: number, id: string) {
	return Buffer.from(JSON.stringify({ dueAtMs, id })).toString("base64url");
}

function requireOwn(row: NotificationRow | null, scope: string) {
	if (!row || row.scope !== scope) throw new Error("notification_not_found");
	return row;
}

export function listNotificationsInTransaction(
	tx: Database,
	deps: TimerDeps,
	scope: string,
	cursor: string | undefined,
	limit: number | undefined,
) {
	const size = Math.min(
		TIMER_POLICY.listMax,
		Math.max(1, limit ?? TIMER_POLICY.listDefault),
	);
	const mark = decodeDue(cursor);
	const at = deps.now();
	const rows = listNotifications(
		tx,
		scope,
		mark?.dueAtMs ?? null,
		mark?.id ?? null,
		size + 1,
	);
	const page = rows.slice(0, size);
	const last = page.at(-1);
	return {
		serverNow: iso(at),
		items: page.map(notificationDto),
		nextCursor:
			rows.length > size && last ? encodeDue(last.dueAtMs, last.id) : null,
	};
}

export type ClaimResult = {
	serverNow: string;
	notification: TimerNotificationDto;
	claimId?: string;
	leaseUntil?: string;
};

export function claimInTransaction(
	tx: Database,
	deps: TimerDeps,
	id: string,
	scope: string,
	command: unknown,
): ClaimResult {
	const input = parse(claimNotificationSchema, command);
	const row = requireOwn(getNotification(tx, id), scope);
	const at = deps.now();
	if (
		row.status === "claimed" &&
		row.claimRequestId === input.claimRequestId &&
		row.clientId === input.clientId &&
		row.leaseUntilMs !== null &&
		row.leaseUntilMs > at &&
		row.claimId
	) {
		return {
			serverNow: iso(at),
			notification: notificationDto(row),
			claimId: row.claimId,
			leaseUntil: iso(row.leaseUntilMs),
		};
	}
	if (
		row.status === "claimed" &&
		row.leaseUntilMs !== null &&
		row.leaseUntilMs > at &&
		row.clientId !== input.clientId
	)
		throw new Error("notification_claimed");
	if (row.status === "dismissed" || row.status === "played" || row.status === "silent")
		throw new Error("claim_invalid");
	if (at - row.dueAtMs > TIMER_POLICY.soundFreshMs) {
		if (row.status === "pending") {
			if (!silencePending(tx, id, scope, row.revision, "stale", at))
				throw new Error("revision_conflict");
		} else if (row.status === "claimed") {
			if (!silenceClaimedStale(tx, id, at)) throw new Error("claim_invalid");
		}
		const next = requireOwn(getNotification(tx, id), scope);
		return { serverNow: iso(at), notification: notificationDto(next) };
	}
	if (row.status === "claimed" && row.leaseUntilMs !== null && row.leaseUntilMs <= at)
		releaseClaim(tx, id, at);
	const current = requireOwn(getNotification(tx, id), scope);
	if (current.status !== "pending") throw new Error("notification_claimed");
	if (current.revision !== input.expectedRevision)
		throw new Error("revision_conflict");
	const claimId = deps.id();
	const leaseUntil = at + TIMER_POLICY.claimLeaseMs;
	if (
		!claimNotification(
			tx,
			id,
			scope,
			current.revision,
			claimId,
			input.claimRequestId,
			input.clientId,
			leaseUntil,
			at,
		)
	)
		throw new Error("revision_conflict");
	const claimed = requireOwn(getNotification(tx, id), scope);
	deps.log.debug("timer.notification_claimed", {
		timerId: claimed.timerId,
		notificationId: claimed.id,
		status: "claimed",
	});
	return {
		serverNow: iso(at),
		notification: notificationDto(claimed),
		claimId,
		leaseUntil: iso(leaseUntil),
	};
}

export function ackInTransaction(
	tx: Database,
	deps: TimerDeps,
	id: string,
	scope: string,
	command: unknown,
) {
	const input = parse(ackNotificationSchema, command);
	const row = requireOwn(getNotification(tx, id), scope);
	if (row.status === "dismissed") throw new Error("claim_invalid");
	const played = input.outcome === "played";
	const status = played ? "played" : "silent";
	const reason = played ? null : input.outcome === "muted" ? "muted" : "blocked";
	if (row.status === status && row.reason === reason && row.claimId === input.claimId)
		return { serverNow: iso(deps.now()), notification: notificationDto(row) };
	if (row.status === "played" || row.status === "silent")
		throw new Error("claim_invalid");
	const at = deps.now();
	if (
		!settleNotification(
			tx,
			id,
			scope,
			input.claimId,
			input.clientId,
			status,
			reason,
			at,
		)
	)
		throw new Error("claim_invalid");
	const next = requireOwn(getNotification(tx, id), scope);
	deps.log.debug("timer.notification_acked", {
		timerId: next.timerId,
		notificationId: next.id,
		status: next.status,
		reason: next.reason ?? undefined,
	});
	return { serverNow: iso(at), notification: notificationDto(next) };
}

export function silenceInTransaction(
	tx: Database,
	deps: TimerDeps,
	id: string,
	scope: string,
	command: unknown,
) {
	const input = parse(silenceNotificationSchema, command);
	const row = requireOwn(getNotification(tx, id), scope);
	if (row.status === "claimed") throw new Error("notification_claimed");
	if (row.status !== "pending") throw new Error("claim_invalid");
	const at = deps.now();
	if (!silencePending(tx, id, scope, input.expectedRevision, input.reason, at))
		throw new Error("revision_conflict");
	const next = requireOwn(getNotification(tx, id), scope);
	return { serverNow: iso(at), notification: notificationDto(next) };
}

export function releaseExpiredClaims(tx: Database, deps: TimerDeps) {
	const at = deps.now();
	for (const row of expiredClaims(tx, at, TIMER_POLICY.batchSize)) {
		if (at - row.dueAtMs > TIMER_POLICY.soundFreshMs)
			silenceClaimedStale(tx, row.id, at);
		else releaseClaim(tx, row.id, at);
	}
	for (const row of stalePending(
		tx,
		at,
		TIMER_POLICY.soundFreshMs,
		TIMER_POLICY.batchSize,
	))
		silencePending(tx, row.id, row.scope, row.revision, "stale", at);
}
