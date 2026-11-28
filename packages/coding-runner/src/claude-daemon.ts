import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claudeDaemonConfigSchema,
	claudeObservation,
	type ClaudeDaemonConfig,
} from "./claude-contracts";
import { claudeRunnerClient } from "./claude-client";
import { ClaudeService } from "./claude-service";
import { defaultClaudeEnv, resolveClaudeExecutable } from "./claude-policy";
import { atomicWrite, privateDirectory } from "./storage";

/** Detached owner. Only an explicit start launches a Works daemon. */
export function claudeDaemonClient(
	input: ClaudeDaemonConfig,
	options?: { idleMs: number },
) {
	const config = claudeDaemonConfigSchema.parse({
		...input,
		...(options ? { idleMs: options.idleMs } : {}),
	});
	const root = privateDirectory(config.root);
	const workspace = options ? config.workspace : realpathSync(config.workspace);
	const socket = join(root, "claude.sock");
	const client = claudeRunnerClient(
		socket,
		workspace,
		options ? { pinnedWorkspace: true } : undefined,
	);
	let launching: Promise<boolean> | undefined;
	let unavailableUntil = 0;

	async function ensure(): Promise<boolean> {
		for (let i = 0; i < 20; i++) {
			const connected = await client.health();
			if (!connected) break;
			if (!connected.retiring) return options ? true : connected.ready === true;
			await Bun.sleep(50);
		}
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
			for (let i = 0; i < 80; i++) {
				const connected = await client.health();
				if (connected && !connected.retiring)
					return options ? true : connected.ready === true;
				if (failed) break;
				await Bun.sleep(50);
			}
			unavailableUntil = Date.now() + 30_000;
			return false;
		})().finally(() => {
			launching = undefined;
		});
		return launching;
	}

	return {
		...client,
		probe: options ? client.probe : ensure,
		async start(...args: Parameters<typeof client.start>) {
			if (options && realpathSync(workspace) !== workspace)
				throw new Error("claude_workspace_mismatch");
			if (!(await ensure())) throw new Error("claude_runner_unavailable");
			return client.start(...args);
		},
		async retireIdle() {
			return !existsSync(socket) || client.retireIdle();
		},
		async recover(...args: Parameters<typeof client.recover>) {
			if (!options || (await client.health())) return client.recover(...args);
			// The directory lock and retained receipt permit recovery without starting a listener.
			const unavailable = () => {
				throw new Error("claude_recovery_unconfirmed");
			};
			const service = new ClaudeService(
				root,
				workspace,
				unavailable,
				unavailable,
			);
			try {
				const [id, lease, proof] = args;
				return claudeObservation.parse(
					service.request({ operation: "recover", id, lease, proof }),
				);
			} finally {
				await service.close();
			}
		},
	};
}
