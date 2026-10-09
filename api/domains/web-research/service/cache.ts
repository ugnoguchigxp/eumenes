import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
	migrations as memoryMigrations,
	retainRecord,
	readRetainedRecord,
	useRetainedRecord,
	retainedRecordStats,
	evictRetainedRecords,
} from "eumenes-memory/sqlite";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	resultSchema,
	type CacheStatus,
	type ResearchRequest,
	type ResearchResult,
} from "../contracts";

const migration = `
CREATE TABLE web_cache_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
INSERT INTO web_cache_state VALUES (1,0);
CREATE TABLE web_cache_entries(cache_key TEXT PRIMARY KEY, record_id TEXT NOT NULL);
`;
export function openWebCache(path: string) {
	// The first five package migrations precede the host block; future ones append.
	return openStore(
		path,
		[...memoryMigrations.slice(0, 5), migration, ...memoryMigrations.slice(5)],
		{
			incrementalVacuum: true,
		},
	);
}
const scope = "web:owner";
const access = {
	principal: "local:owner",
	scopeKeys: [scope],
	purpose: "research.read",
	policyRevision: "1",
};
export function cacheKey(request: ResearchRequest) {
	if (request.operation !== "read" || request.retention !== "stable")
		return null;
	const url = new URL(request.url);
	url.hash = "";
	return createHash("sha256")
		.update(
			JSON.stringify([
				"llm-fetch@0.1.2",
				"guard-v1",
				"result-v1",
				scope,
				url.href,
				request.retention,
			]),
		)
		.digest("hex");
}
export interface CacheHit {
	result: ResearchResult;
	recordId: string;
	retentionRevision: number;
	generation: number;
}
export interface WebCache {
	generation(): number;
	get(request: ResearchRequest): CacheHit | null;
	use(hit: CacheHit): Promise<boolean>;
	put(
		request: ResearchRequest,
		result: ResearchResult,
		freshUntil: number | null,
		generation: number,
	): Promise<boolean>;
	invalidate(request: ResearchRequest, generation: number): Promise<boolean>;
	clear(): Promise<void>;
	sweep(): Promise<void>;
	status(): CacheStatus;
	close(): Promise<void>;
}
export function createWebCache(
	store: SqliteStore,
	options: {
		now?: () => number;
		maxEntries?: number;
		maxBytes?: number;
		path?: string;
		idleTtlMs?: number;
	} = {},
): WebCache {
	const now = options.now ?? Date.now,
		maxEntries = options.maxEntries ?? 5000,
		maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
	const idleTtlMs = options.idleTtlMs ?? 14 * 86400000;
	if (
		![maxEntries, maxBytes, idleTtlMs].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		idleTtlMs > 365 * 86400000
	)
		throw new Error("invalid_web_cache_options");
	const header = () => ({
		contractVersion: 1 as const,
		access,
		scopeKey: scope,
		clock: { atMs: now() },
	});
	let lastSweepAt: string | null = null;
	let clearing: Promise<void> | null = null;
	let sweeping: Promise<void> | null = null;
	let closing: Promise<void> | null = null;
	const generation = () =>
		store.read(
			(db) =>
				db
					.query<{ generation: number }, []>(
						"SELECT generation FROM web_cache_state WHERE id=1",
					)
					.get()!.generation,
		);
	const stats = () => store.read((db) => retainedRecordStats(db, header()));
	function fileBytes() {
		return options.path
			? [options.path, `${options.path}-wal`, `${options.path}-shm`].reduce(
					(sum, path) => {
						try {
							return sum + statSync(path).size;
						} catch {
							return sum;
						}
					},
					0,
				)
			: 0;
	}
	async function evict(oldest = false, limit = 100) {
		return store.write((db) => {
			const result = evictRetainedRecords(db, { ...header(), oldest, limit });
			for (const id of result.deleted)
				db.query("DELETE FROM web_cache_entries WHERE record_id=?").run(id);
			return result.deleted.length;
		});
	}
	function invalidateInTransaction(db: Database, key: string) {
		const mapping = db
			.query<{ record_id: string }, [string]>(
				"SELECT record_id FROM web_cache_entries WHERE cache_key=?",
			)
			.get(key);
		if (!mapping) return false;
		const result = evictRetainedRecords(db, {
			...header(),
			oldest: true,
			limit: 1,
			recordId: mapping.record_id,
		});
		// A durable dependent may retain its source, but that source must no longer be reused as a cache hit.
		db.query("DELETE FROM web_cache_entries WHERE cache_key=?").run(key);
		return result.deleted.length > 0;
	}
	const service: WebCache = {
		generation,
		get(request) {
			const key = cacheKey(request);
			if (!key || request.freshness === "live" || clearing || closing)
				return null;
			return store.read((db) => {
				const mapping = db
					.query<{ record_id: string }, [string]>(
						"SELECT record_id FROM web_cache_entries WHERE cache_key=?",
					)
					.get(key);
				if (!mapping) return null;
				const hit = readRetainedRecord(db, {
					...header(),
					recordId: mapping.record_id,
				});
				if (hit.status !== "available") return null;
				const parsed = resultSchema.safeParse(JSON.parse(hit.record.content));
				if (!parsed.success) return null;
				return {
					result: { ...parsed.data, cache: "hit" },
					recordId: mapping.record_id,
					retentionRevision: hit.retentionRevision,
					generation: db
						.query<{ generation: number }, []>(
							"SELECT generation FROM web_cache_state WHERE id=1",
						)
						.get()!.generation,
				};
			});
		},
		use(hit) {
			if (closing) return Promise.resolve(false);
			return store.write((db) => {
				if (
					db
						.query<{ generation: number }, []>(
							"SELECT generation FROM web_cache_state WHERE id=1",
						)
						.get()!.generation !== hit.generation
				)
					return false;
				return useRetainedRecord(db, {
					...header(),
					recordId: hit.recordId,
					retentionRevision: hit.retentionRevision,
				});
			});
		},
		async put(request, result, deadline, expectedGeneration) {
			const key = cacheKey(request);
			if (!key || clearing || closing) return false;
			if (deadline === null || deadline <= now())
				return service.invalidate(request, expectedGeneration);
			const text = JSON.stringify(result);
			if (
				Buffer.byteLength(text) > Math.min(maxBytes, 1024 * 1024) ||
				result.failures.length ||
				!result.documents.length
			)
				return false;
			if (fileBytes() > 256 * 1024 * 1024) {
				await service.sweep();
				await service.invalidate(request, expectedGeneration);
				return false;
			}
			const admissionFailure = new Error("cache_capacity_reached");
			return store
				.write((db) => {
					if (clearing || closing) return false;
					if (
						db
							.query<{ generation: number }, []>(
								"SELECT generation FROM web_cache_state WHERE id=1",
							)
							.get()!.generation !== expectedGeneration
					)
						return false;
					if (deadline <= now()) return invalidateInTransaction(db, key);
					const retained = retainRecord(db, {
						record: {
							...header(),
							origin: { namespace: "web", kind: "document", id: key },
							mediaType: "application/json",
							content: text,
							captureState: "complete",
						},
						freshUntilMs: Math.min(deadline, now() + 86400000),
						idleTtlMs,
					});
					if (retained.status !== "captured") return false;
					db.query(
						"INSERT INTO web_cache_entries VALUES (?,?) ON CONFLICT(cache_key) DO UPDATE SET record_id=excluded.record_id",
					).run(key, retained.recordId);
					let current = retainedRecordStats(db, header());
					// Enforce limits after replacement, so refreshing a page does not consume a second slot.
					for (
						let i = 0;
						i < 100 &&
						(current.entries > maxEntries || current.bytes > maxBytes);
						i++
					) {
						const removed = evictRetainedRecords(db, {
							...header(),
							oldest: true,
							limit: 1,
						});
						if (!removed.deleted.length) throw admissionFailure;
						for (const id of removed.deleted)
							db.query("DELETE FROM web_cache_entries WHERE record_id=?").run(
								id,
							);
						current = retainedRecordStats(db, header());
					}
					if (current.entries > maxEntries || current.bytes > maxBytes)
						throw admissionFailure;
					return (
						db
							.query("SELECT 1 FROM web_cache_entries WHERE cache_key=?")
							.get(key) !== null
					);
				})
				.catch((error) => {
					if (error === admissionFailure) return false;
					throw error;
				});
		},
		invalidate(request, expectedGeneration) {
			const key = cacheKey(request);
			if (!key || clearing || closing) return Promise.resolve(false);
			return store.write((db) => {
				if (
					clearing ||
					closing ||
					db
						.query<{ generation: number }, []>(
							"SELECT generation FROM web_cache_state WHERE id=1",
						)
						.get()!.generation !== expectedGeneration
				)
					return false;
				return invalidateInTransaction(db, key);
			});
		},
		clear() {
			if (closing) return Promise.reject(new Error("web_cache_unavailable"));
			if (clearing) return clearing;
			clearing = (async () => {
				// Increment first in the same writer turn; old acquisitions cannot repopulate.
				await store.write((db) =>
					db
						.query(
							"UPDATE web_cache_state SET generation=generation+1 WHERE id=1",
						)
						.run(),
				);
				while (await evict(true)) await Bun.sleep(0);
				if (stats().entries > 0) throw new Error("web_cache_clear_blocked");
			})().finally(() => {
				clearing = null;
			});
			return clearing;
		},
		sweep() {
			if (sweeping) return sweeping;
			if (closing) return Promise.resolve();
			const task = (async () => {
				while (await evict()) await Bun.sleep(0);
				lastSweepAt = new Date(now()).toISOString();
				await store.maintenance?.((db) => {
					db.exec(
						"PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(256)",
					);
				});
			})().finally(() => {
				sweeping = null;
			});
			sweeping = task;
			return task;
		},
		status: () => ({
			enabled: true,
			...stats(),
			generation: generation(),
			lastSweepAt,
		}),
		close() {
			if (closing) return closing;
			closing = (async () => {
				await Promise.allSettled([clearing, sweeping]);
				await store.close();
			})();
			return closing;
		},
	};
	return service;
}
