import { join } from "node:path";
import type { SqliteStore } from "../infrastructure/sqlite";
import { connectRunner, createCoding } from "../domains/coding";
import {
	loadConfig,
	publishSpec,
	workspace,
} from "../../packages/coding-runner/src/host";

export async function createProductionCoding(
	store: SqliteStore,
	configPath: string,
) {
	const config = loadConfig(configPath);
	const runner = await connectRunner({
		executable: process.execPath,
		serverPath: join(
			import.meta.dir,
			"../../packages/coding-runner/src/server.ts",
		),
		configPath,
	});
	const coding = createCoding({
		store,
		runner,
		publishSpec: (ref, spec) => publishSpec(config, ref, spec),
	});
	try {
		const registrations: ReturnType<typeof coding.workspaces> = [];
		for (const w of config.workspaces) {
			workspace(config, w.id);
			const probe = await coding.probe(w.id);
			registrations.push({
				id: w.id,
				branch: w.branch,
				available: probe.available,
				reason: probe.reason,
			});
		}
		for (const old of coding.workspaces())
			if (!registrations.some((w) => w.id === old.id))
				registrations.push({
					...old,
					available: false,
					reason: "workspace_not_registered",
				});
		await store.write((db) => {
			for (const w of registrations)
				coding.registerWorkspaceInTransaction(db, w);
		});
		return { coding, available: registrations.some((w) => w.available) };
	} catch (error) {
		await coding.close();
		throw error;
	}
}
