import { readStoredLarm } from "../api/domains/settings";
import { createLarm } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";

/** Backend-only live runners use the same saved connection as normal inference. */
export function liveLarmSettings(env = process.env) {
	return readStoredLarm(env.EUMENES_DB || "./data/eumenes.sqlite3");
}
export function createLiveLarm(env = process.env) {
	const saved = liveLarmSettings(env);
	if (!saved.baseUrl) throw new Error("saved_larm_connection_unconfigured");
	if (!resolveLarmToken(env)) throw new Error("larm_credential_unconfigured");
	return createLarm({
		...saved,
		baseUrl: saved.baseUrl,
		voice: saved.voice || undefined,
		token: resolveLarmToken(env),
	});
}
