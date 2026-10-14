import { resolve } from "node:path";
import type { Config } from "../infrastructure/config";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	resolveWorldCursorSecret,
	resolveWorldMode,
	WORLD_DEFAULT_SCOPE,
} from "./world";
import { isAdoptedAnswerInTransaction } from "../domains/dialogue";
import { createGoalsAssembly, GOALS_ACCESS } from "./goals-assembly";
import { createStewardAssembly } from "./steward-assembly";
import type { MemoryService } from "../domains/memory";
import { createWorldView, type StewardService } from "../domains/steward";
import { WORLD_CURATE_PURPOSE } from "../domains/world";

type WorldInput = Parameters<typeof createWorldAssembly>[0];

/**
 * World as the server runs it. The mode is decided here, once, from the saved setting
 * `world.enabled` and the presence of World content (see `resolveWorldMode`): nothing when off;
 * lifecycle only for protect; with World ON the steward curates what the feeds received
 * (`assembly.curation`). World never starts a model call itself.
 */
export function assembleServerWorld(
	config: Config,
	deps: Pick<WorldInput, "store" | "conversation"> & {
		memory: WorldInput["memory"] &
			Pick<MemoryService, "blockedMessageIdsInTransaction">;
		/** Received input wakes the steward, which curates it. */
		steward: Pick<StewardService, "kickInTransaction">;
		dbPath: string;
		memoryJournalPath: string;
	},
) {
	const { store, conversation, memory, steward } = deps;
	// An adopted answer is the only assistant input; blocked messages are never input.
	const intake = {
		isAdoptedAnswer: isAdoptedAnswerInTransaction,
		blockedMessageIds: (
			db: Parameters<typeof isAdoptedAnswerInTransaction>[0],
			ids: readonly string[],
		) => memory.blockedMessageIdsInTransaction(db, ids),
		onEventsReceived: (conversationIds: readonly string[]) =>
			store.write((db) => {
				for (const id of conversationIds) steward.kickInTransaction(db, id);
			}),
	};
	const mode = resolveWorldMode(store);
	return mode === "off"
		? undefined
		: createWorldAssembly({
				store,
				conversation,
				memory,
				mode,
				intake,
				journalPath: resolve(
					config.worldJournalPath ??
						defaultWorldJournalPath(deps.memoryJournalPath),
				),
				cursorSecret: resolveWorldCursorSecret({
					dbPath: deps.dbPath,
					keyDir: config.env.EUMENES_KEY_DIR,
					env: { EUMENES_WORLD_CURSOR_SECRET: config.worldCursorSecret },
				}),
				...(config.worldPollMs ? { pollMs: config.worldPollMs } : {}),
			});
}

/**
 * What keeps the conversation's memory: the steward, the goals it maintains and the World it
 * curates (World only when its setting or its content asks for it).
 */
export function assembleCuration(
	config: Config,
	deps: Parameters<typeof createStewardAssembly>[0] &
		Omit<Parameters<typeof assembleServerWorld>[1], "steward">,
) {
	const goals = createGoalsAssembly(deps.store);
	// World wakes the steward after its intake, and the steward curates World: the kick is bound late.
	let kick: StewardService["kickInTransaction"] | undefined;
	const world = assembleServerWorld(config, {
		...deps,
		steward: { kickInTransaction: (db, id) => kick?.(db, id) },
	});
	const stewardAssembly = createStewardAssembly({
		...deps,
		goals: { ops: goals.goals, access: GOALS_ACCESS },
		...(world
			? {
					world: {
						curation: world.curation,
						view: createWorldView({
							service: world.service,
							purpose: WORLD_CURATE_PURPOSE,
							scope: WORLD_DEFAULT_SCOPE,
						}),
						resumeForget: (forgetId: string) =>
							world.lifecycle.resumeForget(forgetId),
						scope: WORLD_DEFAULT_SCOPE,
					},
				}
			: {}),
	});
	const { steward } = stewardAssembly;
	kick = steward.kickInTransaction;
	return { stewardAssembly, steward, goals, world };
}
