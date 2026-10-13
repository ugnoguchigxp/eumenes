import { objectRecognitionBuiltins } from "../builtin/object-recognition";
import { excalidrawBuiltins } from "../builtin/excalidraw";
import { imageBuiltins } from "../builtin/image";
import { musicBuiltins } from "../builtin/music";
import type { Database } from "bun:sqlite";
import type { Definition } from "../contracts";
import { builtins } from "../builtin/web-research";
import { dotsBuiltins } from "../builtin/dots";
import { historyBuiltins } from "../builtin/history";
import { timerBuiltins } from "../builtin/timers";
import { toolchainBuiltins } from "../builtin/toolchains";
import { getLogger } from "../../../infrastructure/logger";
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
	if (backends.has("excalidraw"))
		for (const d of excalidrawBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("object-recognition"))
		for (const d of objectRecognitionBuiltins)
			registerBuiltinInTransaction(db, d);
	if (backends.has("image"))
		for (const d of imageBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("music"))
		for (const d of musicBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("dots"))
		for (const d of dotsBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("history"))
		for (const d of historyBuiltins) registerBuiltinInTransaction(db, d);
	if (backends.has("timer"))
		for (const d of timerBuiltins) registerBuiltinInTransaction(db, d);
	// A toolchain is offered only when its whole package is registered on this host.
	for (const d of toolchainBuiltins) {
		if (
			!db
				.query("SELECT 1 FROM capability_revisions WHERE id=?")
				.get(d.packageRevisionId!)
		)
			continue;
		const name = "capabilities_toolchain";
		db.exec(`SAVEPOINT ${name}`);
		try {
			registerBuiltinInTransaction(db, d);
			db.exec(`RELEASE ${name}`);
		} catch (e) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			getLogger("capabilities").warn("toolchain.registration_failed", {
				subjectId: `toolchain:${d.id}@${d.revision}`,
				reason: e instanceof Error ? e.message : "unknown",
			});
		}
	}
}
