import type { Database } from "bun:sqlite";
import type { Settings, Purpose, Connection } from "../contracts";
import { read } from "../repository";

export function validSettings(
	db: Database,
	snapshot: Settings,
	purpose: Purpose,
	connection?: Connection,
) {
	const current = read(db);
	const before = snapshot.routes[purpose];
	const after = current.routes[purpose];
	if (
		connection &&
		(!after.cloudAllowed ||
			after.epoch !== before.epoch ||
			!current.connections.some(
				(c) =>
					c.id === connection.id && c.enabled && c.epoch === connection.epoch,
			))
	)
		return false;
	return true;
}
