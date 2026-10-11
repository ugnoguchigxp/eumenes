import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { startTrialProvider } from "./provider.mjs";

const [origin, connectionRef] = process.argv.slice(2);
if (!origin || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(connectionRef ?? ""))
	throw new Error("usage: node start.mjs HTTPS_ORIGIN CONNECTION_REF");
const directory = resolve(
	process.env.EUMENES_DOTS_AUTH_STATE ??
		join(homedir(), ".local/state/eumenes-dots-oauth-trial"),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const config = {
	origin,
	connectionRef,
	resource: `${origin}/mcp/dots/${connectionRef}`,
	subject: `trial-owner-${randomUUID()}`,
	clientId: `eumenes-chatgpt-${randomUUID()}`,
	until: Date.now() + 7200000,
};
const adminToken = randomBytes(32).toString("hex");
writeFileSync(join(directory, "admin.token"), adminToken, { mode: 0o600 });
chmodSync(join(directory, "admin.token"), 0o600);
const service = await startTrialProvider({ ...config, adminToken });
writeFileSync(
	join(directory, "configuration.json"),
	JSON.stringify(config, null, 2),
	{ mode: 0o600 },
);
process.stdout.write(
	`OAuth trial listening on loopback ${service.port}; local approval ${service.adminPort}; expires ${new Date(config.until).toISOString()}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, async () => {
		await service.stop();
		process.exit(0);
	});
setTimeout(async () => {
	await service.stop();
	process.exit(0);
}, config.until - Date.now()).unref();
