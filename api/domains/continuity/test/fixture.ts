import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createContinuityService } from "..";
/** The service for the domain fixtures; production reads in its own transaction. */
export function createContinuityFixture(
	_store: SqliteStore,
	...args: Parameters<typeof createContinuityService>
) {
	return createContinuityService(...args);
}
