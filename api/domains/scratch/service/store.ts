import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statfsSync, unlinkSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "../../../infrastructure/logger";
import {
	scratchLimits,
	scratchMimes,
	scratchName,
	type ScratchItem,
	type ScratchPut,
} from "../contracts";

const log = getLogger("scratch");

export type ScratchLimits = typeof scratchLimits;

export type ScratchStoreOptions = {
	/** `<dataDir>/scratch`: every boot writes only below its own `<bootId>` directory. */
	root: string;
	bootId?: string;
	now?: () => number;
	id?: () => string;
	limits?: Partial<ScratchLimits>;
	/** Free bytes on the volume of `path`; null when the volume cannot say. */
	freeBytes?: (path: string) => number | null;
};

function volumeFree(path: string): number | null {
	try {
		const s = statfsSync(path);
		return Number(s.bavail) * Number(s.bsize);
	} catch {
		return null;
	}
}

/** Control characters and line breaks never reach a label the conversation reads. */
const cleanName = (name: string) =>
	name.replace(/[\u0000-\u001f\u007f]+/g, " ");

/**
 * The server-lifetime file store (spec/server-scratch-cache-design-2026-11-07.md §5〜§7). Content lives in files
 * under `<root>/<bootId>/<uuid>`; the index lives only in this process, so every boot starts empty.
 */
export function createScratchStore(options: ScratchStoreOptions) {
	const limits: ScratchLimits = { ...scratchLimits, ...options.limits };
	const now = options.now ?? Date.now;
	const newId = options.id ?? randomUUID;
	const freeBytes = options.freeBytes ?? volumeFree;
	const bootId = options.bootId ?? randomUUID();
	const dir = join(options.root, bootId);
	const items = new Map<string, ScratchItem>();
	/** `<conversationId>:<sha256>` of an item put without its own id. */
	const byDigest = new Map<string, string>();
	const leases = new Map<string, Map<string, number>>();
	let used = 0;
	/** Bytes of writes still on their way to disk. */
	let reserved = 0;
	let ready = false;

	const ensureDir = () => {
		if (ready) return;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		ready = true;
	};
	const pathOf = (id: string) => join(dir, id);
	const leased = (id: string) => {
		const held = leases.get(id);
		if (!held) return false;
		const at = now();
		for (const [token, until] of held) if (until <= at) held.delete(token);
		if (!held.size) leases.delete(id);
		return held.size > 0;
	};
	function remove(item: ScratchItem) {
		items.delete(item.id);
		leases.delete(item.id);
		const key = `${item.conversationId}:${item.digest}`;
		if (byDigest.get(key) === item.id) byDigest.delete(key);
		used -= item.bytes;
		try {
			unlinkSync(pathOf(item.id));
		} catch {
			// Already gone; the index no longer holds it either way.
		}
	}
	/** Evicts least recently used, unleased items so a write of `size` fits; throws when it cannot. */
	function makeRoom(size: number) {
		const free = () => freeBytes(options.root);
		const startFree = free();
		let freed = 0;
		const over = (bound: number) =>
			used + reserved + size > bound ||
			items.size + 1 > limits.items ||
			(startFree !== null && startFree + freed - size < limits.minFreeBytes);
		if (!over(limits.capacityBytes)) return;
		const before = { items: items.size, bytes: used };
		const reason =
			startFree !== null && startFree - size < limits.minFreeBytes
				? "disk"
				: items.size + 1 > limits.items
					? "items"
					: "capacity";
		for (const item of [...items.values()].sort(
			(a, b) => a.usedAt - b.usedAt,
		)) {
			if (!over(limits.targetBytes)) break;
			if (leased(item.id)) continue;
			freed += item.bytes;
			remove(item);
		}
		if (before.items !== items.size)
			log.info("scratch.evicted", {
				reason,
				count: before.items - items.size,
				bytes: before.bytes - used,
			});
		if (over(limits.capacityBytes)) throw new Error("scratch_capacity");
	}

	return {
		/** Creates this boot's directory and removes every other boot's in the background. */
		start() {
			ensureDir();
			void (async () => {
				try {
					for (const entry of await readdir(options.root))
						if (entry !== bootId)
							await rm(join(options.root, entry), {
								recursive: true,
								force: true,
							});
				} catch (error) {
					log.warn("scratch.sweep_failed", {
						reason: (error as { code?: string }).code ?? "unknown",
					});
				}
			})();
		},
		/** Removes this boot's files; a later boot removes what is left if this fails. */
		close() {
			items.clear();
			byDigest.clear();
			leases.clear();
			used = 0;
			ready = false;
			rmSync(dir, { recursive: true, force: true });
		},
		/**
		 * Stores a file. With `id` (an attachment's own id, a request's id) the same id returns the stored item;
		 * without one, the same conversation and content return the item already there.
		 */
		async put(input: ScratchPut & { id?: string }): Promise<ScratchItem> {
			if (!(scratchMimes as readonly string[]).includes(input.mime))
				throw new Error("scratch_type_unsupported");
			const name = scratchName.safeParse(cleanName(input.name));
			if (!name.success) throw new Error("scratch_name_invalid");
			if (input.data.length === 0) throw new Error("scratch_empty");
			if (input.data.length > limits.itemBytes)
				throw new Error("scratch_too_large");
			const digest = createHash("sha256").update(input.data).digest("hex");
			const key = `${input.conversationId}:${digest}`;
			const existing = input.id
				? items.get(input.id)
				: items.get(byDigest.get(key) ?? "");
			if (existing) {
				if (
					existing.conversationId !== input.conversationId ||
					existing.digest !== digest
				)
					throw new Error("request_conflict");
				existing.usedAt = now();
				return existing;
			}
			ensureDir();
			makeRoom(input.data.length);
			const id = input.id ?? newId();
			const temp = join(dir, `.${id}.${randomUUID()}`);
			reserved += input.data.length;
			let raced: ScratchItem | undefined;
			try {
				await Bun.write(temp, input.data);
				// A concurrent put of the same id or content finished first: keep its file.
				raced = input.id ? items.get(id) : items.get(byDigest.get(key) ?? "");
				if (raced) await rm(temp, { force: true });
				else await rename(temp, pathOf(id));
			} catch (error) {
				await rm(temp, { force: true });
				throw error;
			} finally {
				reserved -= input.data.length;
			}
			if (raced) {
				if (raced.digest !== digest) throw new Error("request_conflict");
				raced.usedAt = now();
				return raced;
			}
			const at = now();
			const item: ScratchItem = {
				id,
				conversationId: input.conversationId,
				name: name.data,
				mime: input.mime,
				bytes: input.data.length,
				digest,
				origin: input.origin,
				maker: input.maker,
				...(input.width ? { width: input.width } : {}),
				...(input.height ? { height: input.height } : {}),
				...(input.annotation ? { annotation: input.annotation } : {}),
				createdAt: at,
				usedAt: at,
			};
			items.set(id, item);
			if (!input.id) byDigest.set(key, id);
			used += item.bytes;
			return item;
		},
		/** The item without touching it; null when it is not (or no longer) here. */
		get(id: string): ScratchItem | null {
			return items.get(id) ?? null;
		},
		/** Marks the item as used now (read, handed to an agent). */
		touch(id: string) {
			const item = items.get(id);
			if (item) item.usedAt = now();
		},
		/** The file of the item, touched; null when it is gone. */
		file(id: string): { item: ScratchItem; path: string } | null {
			const item = items.get(id);
			if (!item) return null;
			item.usedAt = now();
			return { item, path: pathOf(id) };
		},
		async bytes(id: string): Promise<Uint8Array> {
			const item = items.get(id);
			if (!item) throw new Error("item_not_found");
			item.usedAt = now();
			return new Uint8Array(await Bun.file(pathOf(id)).arrayBuffer());
		},
		/** The conversation's items, most recently used first. */
		list(conversationId: string): ScratchItem[] {
			return [...items.values()]
				.filter((item) => item.conversationId === conversationId)
				.sort((a, b) => b.usedAt - a.usedAt);
		},
		/** Every item, most recently used first. */
		all(): ScratchItem[] {
			return [...items.values()].sort((a, b) => b.usedAt - a.usedAt);
		},
		/** Keeps the item from eviction until the returned release runs or `leaseMs` passes. */
		lease(id: string): () => void {
			if (!items.has(id)) throw new Error("item_not_found");
			const token = randomUUID();
			const held = leases.get(id) ?? new Map<string, number>();
			held.set(token, now() + limits.leaseMs);
			leases.set(id, held);
			return () => {
				const current = leases.get(id);
				current?.delete(token);
				if (current && !current.size) leases.delete(id);
			};
		},
		usage() {
			return { items: items.size, bytes: used };
		},
	};
}
export type ScratchStore = ReturnType<typeof createScratchStore>;
