/** Isolated browser fixture. Google consent is simulated; production never loads this provider. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../api/application/app";
import { appModules } from "../api/application/app-modules";
import {
	buildServices,
	appServices,
	createLifecycles,
} from "../api/application/server";
import { createLifecycleRunner } from "../api/application/lifecycle";
import { loadConfig } from "../api/infrastructure/config";
import { configureLogging } from "../api/infrastructure/logger";
import {
	GoogleAccountError,
	type GoogleProvider,
	type Authorization,
} from "../api/domains/google-accounts/contracts";
const dir = mkdtempSync(join(tmpdir(), "eumenes-google-browser-"));
const config = loadConfig({
	EUMENES_DB: join(dir, "db.sqlite3"),
	EUMENES_KEY_DIR: join(dir, "keys"),
	EUMENES_LOG_FILE: "-",
	EUMENES_HOST: "127.0.0.1",
	EUMENES_PORT: process.env.EUMENES_PORT ?? "0",
	EUMENES_ORIGIN: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
	EUMENES_API_TOKEN: "fixture-token-for-toolchain-browser",
	EUMENES_ATTITUDE_DATASET: join(dir, "dataset.sqlite3"),
	EUMENES_MEMORY_JOURNAL: join(dir, "journal.jsonl"),
	EUMENES_WEB_RESEARCH_TOOLS_ENABLED: "0",
});
configureLogging({ file: config.logFile, level: "warn" });
const attempts = new Map<string, Authorization>();
let revoked = false;
const provider: GoogleProvider = {
	identity: "fixture-google",
	authorization(input) {
		const code = randomUUID();
		attempts.set(code, input);
		return `http://127.0.0.1:${config.port}/fixture/google/authorize?code=${code}`;
	},
	async exchange(code, verifier, nonce) {
		const a = attempts.get(code);
		attempts.delete(code);
		if (!a || a.verifier !== verifier || a.nonce !== nonce)
			throw new GoogleAccountError("invalid_authorization");
		revoked = false;
		return {
			profile: {
				sub: "fixture-person",
				name: "山田 花子",
				email: "hanako@example.com",
			},
			tokens: {
				refresh: "fixture-private-refresh",
				access: "fixture-private-access",
				expires: Date.now() - 1,
			},
		};
	},
	async refresh(token) {
		if (revoked) throw new GoogleAccountError("invalid_grant");
		return {
			refresh: token,
			access: "new-private-access",
			expires: Date.now() - 1,
		};
	},
	async revoke() {
		revoked = true;
	},
};
const services = await buildServices(config, { googleProvider: provider });
let server: ReturnType<typeof Bun.serve> | undefined;
const runner = createLifecycleRunner(
	createLifecycles(services, { name: "http", close: () => server?.stop(true) }),
);
await runner.recoverAll();
await runner.startAll();
const app = createApp({
	token: config.apiToken!,
	origin: config.origin,
	modules: [
		...appModules(appServices(services)),
		{
			mount(app) {
				app.get("/fixture/google/authorize", (c) => {
					const code = c.req.query("code") ?? "";
					const a = attempts.get(code);
					if (!a) return c.text("Expired", 400);
					const target = new URL("/oauth/google/callback", config.origin);
					target.searchParams.set("state", a.state);
					const deny = new URL(target);
					deny.searchParams.set("error", "access_denied");
					target.searchParams.set("code", code);
					return c.html(
						`<html lang="ja"><meta charset="utf-8"><h1>Google認証の試験画面</h1><a href="${target.href}">接続を許可</a><a href="${deny.href}">許可しない</a></html>`,
					);
				});
				app.post("/api/fixture/google/revoke", async (c) => {
					revoked = true;
					await services.googleAccounts.maintain();
					return c.json({ ok: true });
				});
			},
		},
	],
});
server = Bun.serve({
	hostname: config.host,
	port: config.port,
	fetch: app.fetch,
	idleTimeout: 60,
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		void runner.closeAll(10_000).finally(() => {
			rmSync(dir, { recursive: true, force: true });
			process.exit(0);
		});
	});
