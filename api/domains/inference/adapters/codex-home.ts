import { mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Eumenes' own Codex home: nothing of the person's AGENTS.md, skills, MCP servers or default model reaches a
 * call. A CLI login is shared by linking `auth.json` to the person's (Codex writes a refreshed login in place
 * through the link, so the link survives and the person's own Codex stays logged in).
 */
export type CodexHome = {
	/** `CODEX_HOME` of every app-server process. */
	readonly path: string;
	/** The fixed, empty working directory of every app-server process. */
	readonly cwd: string;
	/** Empties the home (the login link aside) once, when the backend starts; a failed try is made again. */
	ready(): Promise<void>;
	/** Empties the home again, when no process is left that could be using it. */
	reset(): Promise<void>;
	/** Removes the record files of threads whose process is gone. */
	removeRecords(threadIds: readonly string[]): Promise<void>;
};

export function createCodexHome(
	path: string,
	personalAuth: string | null,
): CodexHome {
	const cwd = join(path, "workspace");
	const rebuild = async () => {
		await rm(path, { recursive: true, force: true });
		await mkdir(cwd, { recursive: true, mode: 0o700 });
		if (!personalAuth) return;
		try {
			await stat(personalAuth);
		} catch {
			return; // no CLI login: an API key connection needs none
		}
		await symlink(personalAuth, join(path, "auth.json"));
	};
	let state: Promise<void> | undefined;
	/** A rebuild that failed is not kept: the next use tries again. */
	const kept = (work: Promise<void>) => {
		const guarded = work.catch((error) => {
			if (state === guarded) state = undefined;
			throw error;
		});
		guarded.catch(() => {});
		return guarded;
	};
	return {
		path,
		cwd,
		ready: () => (state ??= kept(rebuild())),
		reset: () =>
			(state = kept(
				(state ?? Promise.resolve()).catch(() => {}).then(rebuild),
			)),
		async removeRecords(threadIds) {
			if (!threadIds.length) return;
			const walk = async (dir: string, depth: number): Promise<void> => {
				let entries;
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const file = join(dir, entry.name);
					if (entry.isDirectory()) {
						if (depth < 6 && entry.name !== "skills")
							await walk(file, depth + 1);
					} else if (threadIds.some((id) => entry.name.includes(id)))
						await rm(file, { force: true });
				}
			};
			await walk(path, 0);
		},
	};
}
