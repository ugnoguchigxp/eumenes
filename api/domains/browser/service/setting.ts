import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { settingSave } from "../contracts";
import type { ExecutablePicker } from "../contracts/ports";
import { executablePath, saveExecutablePath } from "../repository";

/** The saved Brave path: read, offered from a standard install, chosen in the OS dialog, saved. */
export function createSetting(deps: {
	store: SqliteStore;
	now: () => number;
	standardPaths?: readonly string[];
	pickExecutable?: ExecutablePicker;
}) {
	const { store } = deps;
	let browsing = false;
	return {
		get: () => ({ executablePath: store.read(executablePath) }),
		/** A standard install that exists, offered for saving; never used until the user saves it. */
		suggest: async () => {
			if (store.read(executablePath)) return null;
			for (const path of deps.standardPaths ?? standardBravePaths())
				if (await isExecutableFile(path)) return path;
			return null;
		},
		canBrowse: Boolean(deps.pickExecutable),
		/** One dialog at a time; the chosen path is checked like a typed one and is not saved here. */
		browse: async () => {
			if (!deps.pickExecutable) throw new Error("browser_browse_unsupported");
			if (browsing) throw new Error("browser_browse_busy");
			browsing = true;
			try {
				const path = await deps.pickExecutable();
				if (path === null) return { path: null };
				if (!(await isExecutableFile(path)))
					throw new Error("browser_executable_invalid");
				return { path };
			} finally {
				browsing = false;
			}
		},
		save: async (path: string) => {
			const parsed = settingSave.parse({ executablePath: path });
			if (
				parsed.executablePath &&
				!(await isExecutableFile(parsed.executablePath))
			)
				throw new Error("browser_executable_invalid");
			return store.write((db) => {
				saveExecutablePath(db, parsed.executablePath, deps.now());
				return { executablePath: executablePath(db) };
			});
		},
	};
}

function standardBravePaths() {
	const app = "Brave Browser.app/Contents/MacOS/Brave Browser";
	if (process.platform === "darwin")
		return [join("/Applications", app), join(homedir(), "Applications", app)];
	if (process.platform === "linux")
		return [
			"/usr/bin/brave-browser",
			"/usr/bin/brave",
			"/opt/brave.com/brave/brave-browser",
		];
	return [];
}

/** The Brave setting must name a file that exists, is a regular file and has an execute bit; nothing else is ever launched. */
async function isExecutableFile(path: string) {
	if (!isAbsolute(path)) return false;
	try {
		const info = await stat(path);
		return info.isFile() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}
