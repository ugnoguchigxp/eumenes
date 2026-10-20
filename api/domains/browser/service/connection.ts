import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	RETENTION_MS,
	unavailableReason,
	type ConnectionEndReason,
	type ConnectionView,
} from "../contracts";
import type { DriverConnectionState } from "../contracts/ports";
import {
	activeConnection,
	connectionRow,
	executablePath,
	insertConnection,
	lastConnection,
	loseTabs,
	patchConnection,
	pruneTabs,
	purgeEnded,
} from "../repository";
import type { Ctx } from "./context";
import { settleLostConnection } from "./lifecycle";
import { reconcileChecked } from "./tabs";

const log = getLogger("browser");
const iso = (ms: number | null) =>
	ms === null ? null : new Date(ms).toISOString();
/** Ends that mean the browser could not be used at all, as opposed to a connection that was over. */
const FAILURES = new Set([
	"connect_timeout",
	"mcp_unavailable",
	"not_configured",
]);

export function connectionView(ctx: Ctx, db: Database): ConnectionView {
	const configured = !!executablePath(db);
	const row = lastConnection(db);
	const state = row?.state ?? "disconnected";
	const live =
		row?.state === "connected" &&
		ctx.driver.state().state === "connected" &&
		row.credential_revision === ctx.credentialRevision();
	return {
		connectionId: row?.id ?? null,
		state,
		startedAt: iso(row?.started_at ?? null),
		connectedAt: iso(row?.connected_at ?? null),
		endedAt: iso(row?.ended_at ?? null),
		endReason: row?.end_reason ?? null,
		configured,
		autoConnectAvailable: ctx.canAutoConnect(),
		availability:
			configured && live
				? { available: true }
				: {
						available: false,
						reason: unavailableReason(
							configured,
							live
								? "connected"
								: state === "connected"
									? "disconnected"
									: state,
							row?.end_reason ?? null,
						),
					},
	};
}

/** The connected connection a request may work on, or the error code that explains why there is none. */
export function connectedConnection(ctx: Ctx, db: Database) {
	const row = activeConnection(db);
	if (
		!row ||
		row.state !== "connected" ||
		ctx.driver.state().state !== "connected" ||
		row.credential_revision !== ctx.credentialRevision()
	)
		throw new Error("browser_disconnected");
	return row;
}

type Running = {
	id: string;
	abort: AbortController;
	done: Promise<void>;
	endReason?: ConnectionEndReason;
};

/**
 * connecting → connected → disconnected/failed. The driver is only called outside writer transactions, and
 * the browser is never reconnected on its own: a lost connection invalidates every tab ref, leaves in-flight
 * operations indeterminate and waits for the user.
 */
export function createConnection(ctx: Ctx) {
	let running: Running | null = null;

	function endInTransaction(
		db: Database,
		id: string,
		reason: ConnectionEndReason,
	) {
		const row = connectionRow(db, id);
		if (!row || (row.state !== "connecting" && row.state !== "connected"))
			return false;
		const now = ctx.now();
		patchConnection(
			db,
			id,
			{
				state: FAILURES.has(reason) ? "failed" : "disconnected",
				ended_at: now,
				end_reason: reason,
			},
			now,
		);
		loseTabs(db, id, now);
		settleLostConnection(ctx, db);
		return true;
	}
	async function end(id: string, reason: ConnectionEndReason) {
		const ended = await ctx.store.write((db) =>
			endInTransaction(db, id, reason),
		);
		if (!ended) return;
		for (const c of ctx.inflight.values())
			c.abort(new Error("browser_disconnected"));
		log.info("browser.connection_ended", { connectionId: id, reason });
	}

	/** Backend restart: nothing of the previous process is alive, so its connection and operations end. */
	const ready: Promise<void> = ctx.store
		.write((db) => {
			const active = activeConnection(db);
			if (active) endInTransaction(db, active.id, "backend_restart");
			const stale = db
				.query(
					"SELECT DISTINCT connection_id AS id FROM browser_tabs WHERE status='open'",
				)
				.all() as { id: string }[];
			for (const s of stale) loseTabs(db, s.id, ctx.now());
			settleLostConnection(ctx, db);
			pruneTabs(db, ctx.now() - RETENTION_MS);
			purgeEnded(db, ctx.now() - RETENTION_MS);
		})
		.catch((e) => log.error("browser.recover_failed", {}, e));

	ctx.driver.onStateChange((state: DriverConnectionState) => {
		if (state.state !== "disconnected") return;
		void (async () => {
			const active = ctx.store.read(activeConnection);
			if (!active) return;
			const reason: ConnectionEndReason =
				(running?.id === active.id ? running.endReason : undefined) ??
				state.reason ??
				"process_exited";
			await end(active.id, reason);
		})().catch((e) => log.error("browser.state_change_failed", {}, e));
	});

	async function run(entry: Running) {
		let result: DriverConnectionState;
		try {
			result = await ctx.driver.connect(entry.abort.signal);
		} catch {
			result = { state: "disconnected", reason: "mcp_unavailable" };
		}
		if (result.state !== "connected") {
			await end(
				entry.id,
				entry.endReason ??
					(result.state === "disconnected" ? result.reason : undefined) ??
					"mcp_unavailable",
			);
			return;
		}
		const live = await ctx.store.write((db) => {
			const row = connectionRow(db, entry.id);
			if (row?.state !== "connecting") return false;
			patchConnection(
				db,
				entry.id,
				{ state: "connected", connected_at: ctx.now() },
				ctx.now(),
			);
			return true;
		});
		if (!live) return;
		try {
			await ctx.serialOf(entry.id).run(async () => {
				const list = await ctx.driver.listTabs();
				await reconcileChecked(ctx, entry.id, list);
			});
			if (
				!ctx.store.read((db) => connectionView(ctx, db).availability.available)
			) {
				await end(entry.id, "user");
				return;
			}
			log.info("browser.connected", { connectionId: entry.id });
		} catch {
			await ctx.driver.disconnect().catch(() => undefined);
			await end(entry.id, "mcp_unavailable");
		}
	}

	return {
		ready,
		/** Resolves when the connection attempt in progress has finished (for shutdown and tests). */
		settled: () => running?.done ?? Promise.resolve(),
		/** Starts connecting and returns at once; the user picks the tab in Brave. Idempotent while one is live. */
		async connect(beforeStart?: (db: Database) => void) {
			await ready;
			const started = await ctx.store.write((db) => {
				beforeStart?.(db);
				if (!executablePath(db)) throw new Error("browser_not_configured");
				const active = activeConnection(db);
				if (active) return { id: active.id, fresh: false };
				const id = crypto.randomUUID();
				insertConnection(db, id, ctx.now());
				db.query(
					"UPDATE browser_connections SET credential_revision=? WHERE id=?",
				).run(ctx.credentialRevision(), id);
				return { id, fresh: true };
			});
			if (started.fresh) {
				const entry: Running = {
					id: started.id,
					abort: new AbortController(),
					done: Promise.resolve(),
				};
				running = entry;
				entry.done = run(entry).catch((e) =>
					log.error("browser.connect_failed", { connectionId: entry.id }, e),
				);
			}
			return ctx.store.read((db) => connectionView(ctx, db));
		},
		async disconnect() {
			await ready;
			const active = ctx.store.read(activeConnection);
			if (active) {
				if (running?.id === active.id) {
					running.endReason = "user";
					running.abort.abort();
				}
				await ctx.driver
					.disconnect()
					.catch((e) =>
						log.warn(
							"browser.disconnect_failed",
							{ connectionId: active.id },
							e,
						),
					);
				await end(active.id, "user");
			}
			return ctx.store.read((db) => connectionView(ctx, db));
		},
	};
}
