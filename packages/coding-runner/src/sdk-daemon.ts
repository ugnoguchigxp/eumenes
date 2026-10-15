import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, privateDirectory } from "./storage";
import { sdkConfigSchema, type SdkConfig } from "./sdk-contracts";
import { sdkRunnerClient } from "./sdk-client";

/** Detached SDK owner. Backend shutdown disconnects its client without terminating this process. */
export function sdkDaemonClient(input: SdkConfig) {
	const config = sdkConfigSchema.parse(input);
	const root = privateDirectory(config.root);
	const socket = join(root, "sdk.sock");
	const client = sdkRunnerClient(socket);
	let launching: Promise<void> | undefined;
	async function ensure() {
		try {
			await client.list();
			return;
		} catch {
			/* Probe the local owner before launch. */
		}
		if (launching) return launching;
		launching = (async () => {
			const path = join(root, "sdk-config.json");
			atomicWrite(path, config);
			const env: Record<string, string> = {};
			for (const key of [
				"HOME",
				"SSH_AUTH_SOCK",
				"CODEX_HOME",
				"PATH",
				"TMPDIR",
				"LANG",
				"LC_ALL",
				"SSL_CERT_FILE",
				"SSL_CERT_DIR",
				"NODE_EXTRA_CA_CERTS",
			])
				if (process.env[key] !== undefined) env[key] = process.env[key]!;
			const child = spawn(
				process.execPath,
				[
					fileURLToPath(new URL("./sdk-cli.ts", import.meta.url)),
					"serve",
					path,
				],
				{ detached: true, stdio: "ignore", env },
			);
			let failed = false;
			child.once("error", () => {
				failed = true;
			});
			child.unref();
			for (let i = 0; i < 100; i++) {
				try {
					await client.list();
					return;
				} catch {
					if (failed) break;
					await Bun.sleep(50);
				}
			}
			throw new Error("sdk_runner_unavailable");
		})().finally(() => {
			launching = undefined;
		});
		return launching;
	}
	return {
		...client,
		async start(...args: Parameters<typeof client.start>) {
			await ensure();
			return client.start(...args);
		},
		async events(...args: Parameters<typeof client.events>) {
			await ensure();
			return client.events(...args);
		},
		ensure,
	};
}
