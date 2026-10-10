import type { Database } from "bun:sqlite";
import type { Definition } from "../contracts";
import { builtins } from "../builtin/web-research";
import { dotsBuiltins } from "../builtin/dots";
import { historyBuiltins } from "../builtin/history";
import { timerBuiltins } from "../builtin/timers";
function isSupersededBuiltin(d: (typeof builtins)[number]) {
	return builtins.some(
		(next) =>
			next.kind === d.kind && next.id === d.id && next.revision > d.revision,
	);
}
export function seedBuiltins(
	db: Database,
	backends: Set<string>,
	registerBuiltinInTransaction: (db: Database, d: Definition) => void,
) {
	for (const d of builtins) {
		if (d.backend && !backends.has(d.backend)) continue;
		// Keep the exact archived definition from this installation. Only
		// the newest revision is authoritative for the current seed.
		const superseded = isSupersededBuiltin(d);
		if (
			superseded &&
			db
				.query("SELECT 1 FROM capability_revisions WHERE id=?")
				.get(`${d.kind}:${d.id}@${d.revision}`)
		)
			continue;
		registerBuiltinInTransaction(db, d);
	}
	if (backends.has("dots"))
		for (const d of dotsBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("history"))
		for (const d of historyBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("timer"))
		for (const d of timerBuiltins) registerBuiltinInTransaction(db, d);
}
