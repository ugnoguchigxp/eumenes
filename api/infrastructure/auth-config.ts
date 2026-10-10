import { randomBytes } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

type AuthEnvironment = {
	[key: string]: string | undefined;
	EUMENES_API_TOKEN?: string;
	EUMENES_DB?: string;
	EUMENES_KEY_DIR?: string;
	LARM_API_TOKEN?: string;
	LARM_CONTROL_TOKEN?: string;
};

/** Server-side only: never import into the browser bundle. */
export function resolveLarmToken(
	env: AuthEnvironment | typeof process.env,
): string | undefined {
	return (
		env.LARM_API_TOKEN?.trim() || env.LARM_CONTROL_TOKEN?.trim() || undefined
	);
}

function readTokenFile(path: string): string {
	const token = readFileSync(path, "utf8").trim();
	if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("api_token_file_invalid");
	return token;
}

/**
 * The local API credential is independent of the LARM credential: an explicit
 * EUMENES_API_TOKEN, else a random token kept beside the database (0600).
 */
export function resolveApiToken(
	env: AuthEnvironment | typeof process.env,
): string {
	const explicit = env.EUMENES_API_TOKEN?.trim();
	if (explicit) {
		if (explicit.length < 24)
			throw new Error("EUMENES_API_TOKEN must be at least 24 characters");
		return explicit;
	}
	const dbPath = env.EUMENES_DB?.trim() || "./data/eumenes.sqlite3";
	// Same rule as Settings (createSettings): EUMENES_KEY_DIR, else <dbDir>/keys.
	const keys =
		env.EUMENES_KEY_DIR?.trim() || join(dirname(resolve(dbPath)), "keys");
	const path = join(keys, "api.token");
	try {
		return readTokenFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(keys, { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	// Fill a private temp file first, then link it into place: readers never
	// observe a partial file, and an existing target is never replaced.
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, token, { mode: 0o600, flag: "wx" });
	try {
		linkSync(temp, path);
		return token;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A concurrent starter created it first: share its token.
		if (code === "EEXIST") return readTokenFile(path);
		// Filesystems without hard links: fall back to an exclusive create.
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
			throw error;
		try {
			writeFileSync(path, token, { mode: 0o600, flag: "wx" });
			return token;
		} catch (inner) {
			if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner;
			return readTokenFile(path);
		}
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// Best effort: the temp name is unique and holds no live credential path.
		}
	}
}
