import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../../client";
import { resolveLarmToken } from "../../api/infrastructure/auth-config";
import { createFixture } from "../../tests/browser/fixture";
import { liveLarmSettings } from "../live-larm";
import type { FixtureDef, Group } from "./types";

const FIXTURE_TOKEN = "fixture-token-for-toolchain-browser";

/** Where the browser goes and where the judge reads. Nothing here is visible to the tester. */
export type Target = {
	/** The page the tester starts on. */
	startUrl: string;
	/** Readonly judge reads. */
	hostUrl: string;
	hostToken?: string;
	stop(): Promise<void>;
};

async function seed(
	hostUrl: string,
	token: string | undefined,
	seeds: FixtureDef["seedTimers"],
) {
	for (const timer of seeds) {
		const response = await fetch(new URL("/api/timers", hostUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				durationSeconds: timer.durationSeconds,
				label: timer.label,
			}),
		});
		if (!response.ok) throw new Error(`seed_failed_${response.status}`);
	}
}

/** The pre-migration UI from an externally provided origin. The harness does not start it. */
export async function useBaseline(options: {
	baselineUrl: string;
	apiUrl?: string;
	fixture: FixtureDef;
	env?: NodeJS.ProcessEnv;
}): Promise<Target> {
	const hostUrl = options.apiUrl ?? options.baselineUrl;
	const hostToken = (options.env ?? process.env).EUMENES_NL_BASELINE_TOKEN;
	await seed(hostUrl, hostToken, options.fixture.seedTimers);
	return {
		startUrl: options.baselineUrl,
		hostUrl,
		hostToken,
		stop: async () => {},
	};
}

/** An isolated DB and server per run, with Vite proxying `/api` as the existing browser specs do. */
export async function startIsolated(options: {
	group: Exclude<Group, "baseline">;
	fixture: FixtureDef;
	dir: string;
}): Promise<Target> {
	mkdirSync(options.dir, { recursive: true });
	const fx = createFixture();
	const [apiPort, webPort] = (await fx.ports(2)) as [number, number];
	const apiUrl = `http://127.0.0.1:${apiPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;
	let token = FIXTURE_TOKEN;
	try {
		if (options.fixture.stack === "fixture") {
			await fx.launch(
				["scripts/toolchain-fixture-server.ts"],
				{
					EUMENES_PORT: String(apiPort),
					EUMENES_ORIGIN: webUrl,
					EUMENES_FIXTURE_TIMERS: "1",
				},
				{ ports: [apiPort] },
			);
		} else {
			// The saved LARM connection is the source of truth; the isolated DB receives it through the settings API.
			const saved = liveLarmSettings();
			if (!saved.baseUrl || !resolveLarmToken(process.env))
				throw new Error("saved_larm_connection_unconfigured");
			token = crypto.randomUUID();
			await fx.launch(
				["api/application/server.ts"],
				{
					EUMENES_DB: join(options.dir, "nl.sqlite3"),
					EUMENES_LOG_FILE: join(options.dir, "logs/api.jsonl"),
					EUMENES_LOG_LEVEL: "info",
					EUMENES_API_TOKEN: token,
					EUMENES_PORT: String(apiPort),
					EUMENES_ORIGIN: webUrl,
				},
				{ ports: [apiPort] },
			);
		}
		await fx.waitUntil(
			async () =>
				(
					await fetch(
						new URL(
							options.fixture.stack === "fixture"
								? "/api/timers"
								: "/api/status",
							apiUrl,
						),
						{ headers: { authorization: `Bearer ${token}` } },
					)
				).ok,
			{ message: "api_not_ready" },
		);
		if (options.fixture.stack === "product") {
			const client = createClient(apiUrl, token);
			const settings = await client.settings();
			await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: settings.revision,
				settings: { ...settings, larm: liveLarmSettings() },
				keys: [],
			});
			await client.connectLarm();
			await fx.waitUntil(
				async () => {
					const response = await fetch(new URL("/api/status", apiUrl), {
						headers: { authorization: `Bearer ${token}` },
					});
					return response.ok && (await response.json()).larm.state === "ready";
				},
				{ attempts: 150, message: "larm_not_ready" },
			);
		}
		await fx.launchWeb({
			webPort,
			apiPort,
			token,
			cacheDir: join(options.dir, "vite-cache"),
		});
		await fx.waitUntil(async () => (await fetch(webUrl)).ok, {
			message: "web_not_ready",
		});
		await seed(apiUrl, token, options.fixture.seedTimers);
	} catch (error) {
		await fx.stopAll();
		throw error;
	}
	return {
		startUrl: `${webUrl}/?artifactVariant=${options.group}`,
		hostUrl: apiUrl,
		hostToken: token,
		stop: () => fx.stopAll(),
	};
}
