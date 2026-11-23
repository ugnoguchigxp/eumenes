import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claudeDaemonConfigSchema,
	type ClaudeDaemonConfig,
} from "./claude-contracts";
import { claudeRunnerClient } from "./claude-client";
import { defaultClaudeEnv, resolveClaudeExecutable } from "./claude-policy";
import { atomicWrite, privateDirectory } from "./storage";

/** Detached Claude runner owner. Backend shutdown disconnects without terminating running work. */
export function claudeDaemonClient(input: ClaudeDaemonConfig) {
	const config = claudeDaemonConfigSchema.parse(input);
	const root = privateDirectory(config.root);
	const workspace = realpathSync(config.workspace);
	const socket = join(root, "claude.sock");
	const client = claudeRunnerClient(socket, workspace);
	let launching: Promise<boolean> | undefined;
	let unavailableUntil = 0;

	async function ensure(): Promise<boolean> {
		if (await client.probe()) return true;
		if (Date.now() < unavailableUntil) return false;
		if (!resolveClaudeExecutable(config.executable)) {
			unavailableUntil = Date.now() + 30_000;
			return false;
		}
		if (launching) return launching;
		launching = (async () => {
			const configPath = join(root, "claude-config.json");
			atomicWrite(configPath, { ...config, root, workspace });
			const child = spawn(
				process.execPath,
				[
					fileURLToPath(new URL("./claude-cli.ts", import.meta.url)),
					"serve",
					configPath,
				],
				{ detached: true, stdio: "ignore", env: defaultClaudeEnv() },
			);
			let failed = false;
			child.once("error", () => {
				failed = true;
			});
			child.once("exit", () => {
				failed = true;
			});
			child.unref();
			for (let i = 0; i < 60; i++) {
				if (await client.probe()) return true;
				if (failed) break;
				await Bun.sleep(50);
			}
			// Back off repeated spawns when local auth or CLI setup is unavailable.
			unavailableUntil = Date.now() + 30_000;
			return false;
		})().finally(() => {
			launching = undefined;
		});
		return launching;
	}

	return {
		...client,
		probe: ensure,
		async start(...args: Parameters<typeof client.start>) {
			if (!(await ensure())) throw new Error("claude_runner_unavailable");
			return client.start(...args);
		},
	};
}
