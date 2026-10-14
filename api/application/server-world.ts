import { resolve } from "node:path";
import type { Config } from "../infrastructure/config";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	resolveWorldCursorSecret,
	resolveWorldMode,
} from "./world";
import { createWorldForeground } from "./world-foreground";

type WorldInput = Parameters<typeof createWorldAssembly>[0];

/**
 * World as the server runs it. The mode is decided here, once, from the saved setting
 * `world.enabled` and the presence of World content (see `resolveWorldMode`): nothing when off;
 * lifecycle only for protect; Local extraction and its foreground priority (P4-02, P4-03)
 * only with World ON.
 */
export function assembleServerWorld(
	config: Config,
	deps: Pick<WorldInput, "store" | "conversation" | "memory"> & {
		queue: Parameters<typeof createWorldForeground>[0]["queue"] &
			NonNullable<WorldInput["extraction"]>["queue"];
		inference: Parameters<typeof createWorldForeground>[0]["inference"] &
			NonNullable<WorldInput["extraction"]>["inference"];
		dbPath: string;
		memoryJournalPath: string;
	},
) {
	const { store, conversation, memory, queue, inference } = deps;
	const mode = resolveWorldMode(store);
	const worldForeground =
		mode === "on"
			? createWorldForeground({ store, queue, inference })
			: undefined;
	const world =
		mode === "off"
			? undefined
			: createWorldAssembly({
					store,
					conversation,
					memory,
					mode,
					journalPath: resolve(
						config.worldJournalPath ??
							defaultWorldJournalPath(deps.memoryJournalPath),
					),
					cursorSecret: resolveWorldCursorSecret({
						dbPath: deps.dbPath,
						keyDir: config.env.EUMENES_KEY_DIR,
						env: { EUMENES_WORLD_CURSOR_SECRET: config.worldCursorSecret },
					}),
					...(mode === "on"
						? {
								extraction: {
									queue,
									inference,
									...(worldForeground
										? { foreground: worldForeground.hub }
										: {}),
								},
							}
						: {}),
					...(config.worldPollMs ? { pollMs: config.worldPollMs } : {}),
				});
	return { world, worldForeground };
}
