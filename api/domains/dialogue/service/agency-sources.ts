import type { Database } from "bun:sqlite";
import { workById, confirmationById } from "../repository/work";
import { sha256Hex } from "../../../infrastructure/digest";

/** Validate only this domain's versioned source contracts, never the meaning of their text. */
export function staleAgencySources(
	db: Database,
	refs: readonly string[],
	capabilities: readonly string[],
): string[] {
	return refs.filter((ref) => {
		if (ref.startsWith("host-work:")) {
			const [id, revision] = JSON.parse(ref.slice("host-work:".length)) as [
				string,
				number,
			];
			return workById(db, id)?.revision !== revision;
		}
		if (ref.startsWith("host-confirmation:")) {
			const [id, digest] = JSON.parse(
				ref.slice("host-confirmation:".length),
			) as [string, string];
			const row = confirmationById(db, id);
			return !row || sha256Hex(JSON.stringify(row)) !== digest;
		}
		return (
			ref.startsWith("capability:") &&
			!capabilities.includes(ref.slice("capability:".length))
		);
	});
}
