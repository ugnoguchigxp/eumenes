import type { Database } from "bun:sqlite";
import { sliceUtf8Range } from "eumenes-memory";
import type { StateItem } from "eumenes-memory/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { readSeedSource, SEED_NAMESPACE } from "../repository/seeds";

/** The source is a candidate document, never an original user message. Check its actual bytes on each use. */
export function seedEvidence(db: Database, ref: StateItem["evidence"][number]) {
	if (
		ref.namespace !== SEED_NAMESPACE ||
		ref.kind !== "candidate" ||
		ref.representation !== "text" ||
		!ref.range
	)
		return null;
	const source = readSeedSource(db, ref.id);
	if (
		!source ||
		source.namespace !== ref.namespace ||
		source.kind !== ref.kind ||
		source.id !== ref.id ||
		source.representation !== ref.representation ||
		source.status !== "available" ||
		typeof source.content !== "string" ||
		source.revision !== ref.revision ||
		source.digest !== ref.digest ||
		sha256Hex(source.content) !== ref.digest
	)
		return null;
	const slice = sliceUtf8Range(source.content, ref.range);
	return slice.status === "ok" ? { source, quote: slice.text } : null;
}
