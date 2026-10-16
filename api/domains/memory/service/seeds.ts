import type { Database } from "bun:sqlite";
import {
	classifyValidity,
	periodFromStateMs,
	type HostSourceState,
} from "eumenes-memory";
import { sha256Hex } from "../../../infrastructure/digest";
import {
	memorySeedInputSchema,
	seedStateText,
	type MemorySeed,
	type MemorySeedResult,
} from "../contracts/seeds";
import {
	putProvenance,
	putSeedImport,
	putSeedSource,
	seedImportDigest,
	SEED_NAMESPACE,
} from "../repository";
import { MAX_ACTIVE_ITEMS, type CurationDeps } from "./curation-shared";
import { createStateWriter } from "./curation-state";

/** One additive candidate import. No semantic matching, overwriting, origin promotion or startup auto-import. */
export function createSeedImport(deps: CurationDeps) {
	const writer = createStateWriter(deps);

	function prepare(db: Database, input: { seeds: readonly MemorySeed[] }) {
		const seeds = memorySeedInputSchema
			.parse(input)
			.seeds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const digest = sha256Hex(JSON.stringify(seeds));
		const items = writer.items(db, true);
		const counted = items.filter(
			(item) =>
				item.status === "active" &&
				classifyValidity(
					periodFromStateMs(item.validFromMs, item.validUntilMs),
					deps.atMs(),
				) !== "past",
		).length;
		const availableSlots = Math.max(0, MAX_ACTIVE_ITEMS - counted);
		const counts = {
			total: seeds.length,
			state: seeds.filter((s) => s.proposed_target === "state").length,
			hostProcedure: seeds.filter((s) => s.proposed_target === "host_procedure")
				.length,
			continuity: seeds.filter((s) => s.proposed_target === "continuity")
				.length,
		};
		const receipt = seedImportDigest(db);
		const result: MemorySeedResult = {
			status: receipt === digest ? "unchanged" : receipt ? "blocked" : "ready",
			digest,
			registered: 0,
			counts,
			availableSlots,
			reason: receipt && receipt !== digest ? "different_dataset" : null,
			entries: seeds.map((seed) => {
				const existing = items.find(
					(item) => item.semanticKey === seed.semantic_key,
				);
				return {
					id: seed.id,
					target: seed.proposed_target,
					result:
						seed.proposed_target !== "state"
							? "deferred"
							: receipt === digest
								? "already_processed"
								: existing
									? "existing_key"
									: "ready",
					itemId: existing?.itemId ?? null,
				};
			}),
		};
		if (
			result.status === "ready" &&
			result.entries.filter((e) => e.result === "ready").length > availableSlots
		) {
			result.status = "blocked";
			result.reason = "capacity";
		}
		return { seeds, result };
	}

	function preview(
		db: Database,
		input: { seeds: readonly MemorySeed[] },
	): MemorySeedResult {
		if (!deps.ready()) throw new Error("memory_unavailable");
		return prepare(db, input).result;
	}

	function importInTransaction(
		db: Database,
		input: { seeds: readonly MemorySeed[] },
	): MemorySeedResult {
		if (!deps.ready()) throw new Error("memory_unavailable");
		const { seeds, result } = prepare(db, input);
		if (result.status !== "ready") return result;
		for (const [ordinal, seed] of seeds.entries()) {
			const entry = result.entries[ordinal]!;
			if (entry.result !== "ready") continue;
			const prefix = "本人未確認のSeed候補\n";
			const content = `${prefix}${seedStateText(seed)}\n\n元Seedと出典参照:\n${JSON.stringify(seed)}`;
			const digest = sha256Hex(content);
			const source: HostSourceState = {
				namespace: SEED_NAMESPACE,
				kind: "candidate",
				id: `${result.digest}:${seed.id}`,
				representation: "text",
				revision: `sha256:${digest}`,
				digest,
				principal: deps.scoped(db, "memory.seed").access.principal,
				scopeKey: deps.scoped(db, "memory.seed").scopeKey,
				status: "available",
				content,
				ordinal,
			};
			const written = writer.writeState(db, {
				kind: seed.proposed_state_kind!,
				semanticKey: seed.semantic_key,
				text: seedStateText(seed),
				negated: false,
				origin: "agent_inferred",
				force: false,
				validity: null,
				sources: [source],
				evidence: [
					{
						source: {
							namespace: source.namespace,
							kind: source.kind,
							id: source.id,
							representation: "text",
							revision: source.revision,
							digest: source.digest,
							range: {
								startByte: Buffer.byteLength(prefix),
								endByte: Buffer.byteLength(prefix + seed.memory),
							},
						},
						quote: seed.memory,
					},
				],
			});
			if (!written.ok || !written.changed)
				throw new Error("invalid_memory_seed_write");
			putSeedSource(db, source, written.item.itemId);
			putProvenance(db, written.item.itemId, null, "agent", deps.clock(), true);
			entry.result = "registered";
			entry.itemId = written.item.itemId;
			result.registered++;
		}
		putSeedImport(db, result.digest);
		if (result.registered > 0) {
			deps.windows.recordImmediateInTransaction(db, "state_import", null);
			deps.windows.purgeInTransaction(db);
		}
		result.status = "imported";
		return result;
	}
	return { preview, importInTransaction };
}
