import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import type { DialogueDeps } from "./context";

/**
 * The toolchains whose runtime is available now: bound chains while their adapter is available, the others by
 * host capability. A search offers only these.
 */
export function availableToolchainsInTransaction(
	deps: DialogueDeps,
	db: Database,
	_run?: Run,
): Set<string> {
	return new Set(readyCatalog(deps, db).map((entry) => entry.id));
}

export function readyCatalog(deps: DialogueDeps, db: Database) {
	const { agents, toolchains } = deps;
	if (!toolchains) return [];
	const ready = (requires: string | undefined) =>
		requires === undefined || requires === "world"
			? !!agents
			: requires === "excalidraw"
				? !!deps.excalidraw
				: requires === "object-recognition"
					? !!deps.objectRecognition
					: requires === "image"
						? !!deps.image
						: requires === "music"
							? !!deps.music
							: false;
	return toolchains
		.catalogInTransaction(db)
		.filter(({ runtime }) =>
			runtime.binding ? runtime.binding.available : ready(runtime.requires),
		);
}
