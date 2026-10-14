import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { entrySchema, type Entry } from "../domains/tts-dictionary/contracts";
import type { TtsDictionaryService } from "../domains/tts-dictionary";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const TTS_DICTIONARY_ADAPTER_REF = "adapter:tts-dictionary@1";
const ENTRIES = "query:tts-dictionary.entries@1";
const SAVE = "tts-dictionary.save";
const UPDATE = "tts-dictionary.update";
const DELETE = "tts-dictionary.delete";

/** Add a headword; one that is already registered is a conflict (create never replaces). */
const saveInput = z.strictObject({
	written: z.string().min(1).max(200),
	spoken: z.string().min(1).max(400),
});
/** Change the reading of the row's headword; `expectedSpoken` is the reading the row showed. */
const updateInput = z.strictObject({
	written: z.string().min(1).max(200),
	expectedSpoken: z.string().max(400),
	spoken: z.string().min(1).max(400),
});
/** `expectedSpoken` is the reading the row showed: a changed or removed row is a conflict. */
const deleteInput = z.strictObject({
	written: z.string().min(1).max(200),
	expectedSpoken: z.string().max(400),
});
/** Table query of the source (page, sort, search); the Web sends JSON, the schema coerces. */
const pageQuery = z.strictObject({
	pageIndex: z.coerce.number().int().min(0).max(100_000).default(0),
	pageSize: z.coerce
		.number()
		.pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
		.default(10),
	q: z.string().trim().max(200).default(""),
	sort: z.enum(["written", "spoken"]).default("written"),
	desc: z
		.union([z.boolean(), z.enum(["true", "false"])])
		.transform((v) => v === true || v === "true")
		.default(false),
});

/** The dictionary operations the adapter uses: the domain's public transaction operations. */
export type TtsDictionaryPorts = Pick<
	TtsDictionaryService,
	"listInTransaction" | "saveInTransaction" | "deleteInTransaction"
>;

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A number that changes when the registered entries change (the source revision). */
const revisionOf = (entries: Entry[]) =>
	Number.parseInt(sha256(entries).slice(0, 12), 16);
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What the dictionary adapter offers, without a dictionary service (bundle checks, evaluation). */
export const describeTtsDictionaryAdapter = () => ({
	owner: "tts-dictionary",
	operations: new Map([
		[
			SAVE,
			{
				inputSchemaRef: "schema:tts-dictionary-save@1",
				effect: "write" as const,
			},
		],
		[
			UPDATE,
			{
				inputSchemaRef: "schema:tts-dictionary-update@1",
				effect: "write" as const,
			},
		],
		[
			DELETE,
			{
				inputSchemaRef: "schema:tts-dictionary-delete@1",
				effect: "write" as const,
			},
		],
	]),
	queries: new Set([ENTRIES]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:tts-dictionary@1",
});

/**
 * The typed 読み方辞書 adapter for the data-driven settings screen. Saving and deleting go
 * through the dictionary domain's own transaction operations, so its `expected.spoken` guard,
 * headword rules and compiled-matcher invalidation stay the only source of truth. Never
 * available from a conversation.
 */
export function createTtsDictionaryAdapter(
	dictionary: TtsDictionaryPorts,
): DomainAdapter {
	function done(
		tx: Database,
		kind: "save" | "update" | "delete",
		written: string,
		requestId: string,
	): AdapterResult {
		const receipt = {
			version: 1,
			kind: `dictionary-${kind}`,
			requestId,
			entries: dictionary.listInTransaction(tx).length,
		};
		return {
			receipt,
			receiptRef: {
				owner: "tts-dictionary",
				operationId: requestId,
				digest: sha256(receipt),
			},
			resultRefs: [
				{
					owner: "tts-dictionary",
					kind: "entry",
					id: sha256(written).slice(0, 32),
					schemaRef: "domain:tts-dictionary.entry@1",
				},
			],
			replay: false,
		};
	}
	return {
		ref: TTS_DICTIONARY_ADAPTER_REF,
		describe: describeTtsDictionaryAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request): AdapterResult {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			switch (request.operationName) {
				case SAVE: {
					const parsed = saveInput.safeParse(request.input);
					if (!parsed.success) throw new Error("invalid_input");
					const entry = entrySchema.safeParse({
						written: parsed.data.written.trim(),
						spoken: parsed.data.spoken.trim(),
					});
					if (!entry.success || !entry.data.spoken)
						throw new Error("invalid_entry");
					dictionary.saveInTransaction(tx, {
						original: null,
						entry: entry.data,
						expected: { spoken: null },
					});
					return done(tx, "save", entry.data.written, request.requestId);
				}
				case UPDATE: {
					const parsed = updateInput.safeParse(request.input);
					if (!parsed.success) throw new Error("invalid_input");
					const entry = entrySchema.safeParse({
						written: parsed.data.written,
						spoken: parsed.data.spoken.trim(),
					});
					if (!entry.success || !entry.data.spoken)
						throw new Error("invalid_entry");
					dictionary.saveInTransaction(tx, {
						original: entry.data.written,
						entry: entry.data,
						expected: { spoken: parsed.data.expectedSpoken },
					});
					return done(tx, "update", entry.data.written, request.requestId);
				}
				case DELETE: {
					const parsed = deleteInput.safeParse(request.input);
					if (!parsed.success) throw new Error("invalid_input");
					dictionary.deleteInTransaction(tx, {
						written: parsed.data.written,
						expected: { spoken: parsed.data.expectedSpoken },
					});
					return done(tx, "delete", parsed.data.written, request.requestId);
				}
				default:
					throw new Error("capability_unavailable");
			}
		},
		// The screen reads the list again; a save or delete leaves no body to reload.
		readInTransaction: () => null,
		sourceInTransaction(tx, query, _target, params) {
			if (query !== ENTRIES) return null;
			const parsed = pageQuery.safeParse(params ?? {});
			if (!parsed.success) throw new Error("invalid_input");
			const { q, sort, desc, pageSize } = parsed.data;
			const all = dictionary.listInTransaction(tx);
			const needle = q.toLocaleLowerCase();
			const matches = all.filter(
				(item) =>
					!needle ||
					`${item.written} ${item.spoken}`.toLocaleLowerCase().includes(needle),
			);
			matches.sort(
				(a, b) =>
					(desc ? -1 : 1) *
					(byCode(a[sort], b[sort]) || byCode(a.written, b.written)),
			);
			// A page past the end (after a delete or a search) shows the last page.
			const pageIndex = Math.min(
				parsed.data.pageIndex,
				Math.max(0, Math.ceil(matches.length / pageSize) - 1),
			);
			return {
				revision: revisionOf(all),
				data: {
					pageIndex,
					pageSize,
					total: matches.length,
					items: matches.slice(
						pageIndex * pageSize,
						(pageIndex + 1) * pageSize,
					),
				},
			};
		},
		targetInput: () => ({}),
	};
}
