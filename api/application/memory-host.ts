import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	configSchema,
	profileSchema,
	MemoryHost,
	serveHost,
	type HostConfig,
} from "eumenes-memory-host";
import type { MemoryService } from "../domains/memory";
import { PRINCIPAL, PROFILE_SCOPE } from "../domains/memory/contracts";
import { getLogger } from "../infrastructure/logger";

const log = getLogger("memory");
const localClientId = "local-cli";

function readPrivateJson(path: string): unknown {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink())
		throw Error("memory_host_config_invalid");
	if (entry.mode & 0o077) chmodSync(path, 0o600);
	return JSON.parse(readFileSync(path, "utf8"));
}
function createPrivateJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** App-owned transport: no new database or writer, and no work until recovery. */
export function createMemoryHostConnection(
	memory: MemoryService,
	dataDirectory: string,
) {
	const data = resolve(dataDirectory);
	const directory = join(data, "memory-host");
	const ownerPath = join(directory, "owner.json");
	const profilePath = join(directory, "profile.json");
	const socketPath = join(data, "memory.sock");
	let host: MemoryHost | undefined;
	let transport: Awaited<ReturnType<typeof serveHost>> | undefined;
	let socketInode: number | undefined;
	let accepting = false;
	let state:
		"stopped" | "recovered" | "listening" | "ready" | "unavailable" | "closed" =
		"stopped";
	const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false });
	let lastValidConfiguration: HostConfig | undefined;
	let purgeConfiguration: HostConfig | undefined;
	const configuration = (): HostConfig => {
		if (purgeConfiguration) return purgeConfiguration;
		const config = configSchema.parse(readPrivateJson(ownerPath));
		if (
			config.principal !== PRINCIPAL ||
			config.socketPath !== socketPath ||
			!config.scopeKeys.includes(PROFILE_SCOPE)
		)
			throw Error("memory_host_config_invalid");
		lastValidConfiguration = config;
		return config;
	};
	function prepareConfiguration() {
		if (Buffer.byteLength(socketPath) >= 104)
			throw Error("memory_host_socket_path_too_long");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (
			!lstatSync(directory).isDirectory() ||
			lstatSync(directory).isSymbolicLink()
		)
			throw Error("memory_host_config_invalid");
		chmodSync(directory, 0o700);
		if (!exists(ownerPath)) {
			if (exists(profilePath)) throw Error("memory_host_config_invalid");
			const credential = randomBytes(32).toString("hex");
			createPrivateJson(ownerPath, {
				version: 1,
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				socketPath,
				credentials: {
					[credential]: {
						clientId: localClientId,
						scopeKeys: [PROFILE_SCOPE],
						read: true,
						write: true,
						forgetAll: true,
						confirmedWrites: false,
					},
				},
			});
		}
		const config = configuration();
		if (!exists(profilePath)) {
			const matches = Object.entries(config.credentials).filter(
				([, grant]) => grant.clientId === localClientId,
			);
			if (matches.length !== 1) throw Error("memory_host_profile_missing");
			createPrivateJson(profilePath, {
				version: 1,
				socketPath,
				credential: matches[0]![0],
			});
		}
		const profile = profileSchema.parse(readPrivateJson(profilePath));
		if (
			profile.socketPath !== socketPath ||
			!Object.hasOwn(config.credentials, profile.credential)
		)
			throw Error("memory_host_config_invalid");
	}
	memory.registerForgetPurge((db, purge) => {
		if (!host || !lastValidConfiguration) return;
		// App-owned erasure must not depend on the readability of client credentials.
		// The callback is synchronous; external requests always re-read current configuration.
		const previous = purgeConfiguration;
		purgeConfiguration = lastValidConfiguration;
		try {
			host.invalidateDerivedInTransaction(db, {
				scopeKeys: purgeConfiguration.scopeKeys,
				itemIds: purge.itemIds,
				forgetIds: purge.forgetIds ?? [],
			});
		} finally {
			purgeConfiguration = previous;
		}
	});
	return {
		profilePath,
		socketPath,
		status: () => ({ state }),
		async recover() {
			if (state === "recovered" || state === "listening" || state === "ready")
				return;
			accepting = false;
			if (!memory.status().healthy) {
				state = "unavailable";
				return;
			}
			try {
				prepareConfiguration();
				host = new MemoryHost({
					configuration,
					port: {
						...memory.sharedHost,
						isReady: () => accepting && memory.sharedHost.isReady(),
					},
					resolveSource: memory.sharedHost.resolveSource,
				});
				await host.start();
				state = "recovered";
			} catch {
				state = "unavailable";
				log.warn("memory.host_unavailable", { reason: "setup_failed" });
			}
		},
		async listen() {
			if (state !== "recovered" || !host) return;
			try {
				const old = exists(socketPath);
				if (old) {
					if (!old.isSocket()) throw Error("memory_host_socket_conflict");
					// The app owns the database lock before recovery; the previous owner is gone.
					unlinkSync(socketPath);
				}
				transport = await serveHost(host, socketPath);
				socketInode = lstatSync(socketPath).ino;
				state = "listening";
			} catch {
				state = "unavailable";
				log.warn("memory.host_unavailable", { reason: "listen_failed" });
			}
		},
		start() {
			if (state !== "listening") return;
			accepting = true;
			state = "ready";
			log.info("memory.host_ready", { status: "ready" });
		},
		async close() {
			accepting = false;
			await transport?.close();
			transport = undefined;
			if (host) await Promise.allSettled(host.inFlight.values());
			const current = exists(socketPath);
			if (
				socketInode !== undefined &&
				current?.isSocket() &&
				current.ino === socketInode
			)
				unlinkSync(socketPath);
			socketInode = undefined;
			state = "closed";
		},
	};
}
