import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { freshSignal } from "./larm.fixture";
import { acquireProvider } from "../service/acquire-provider";
import {
	endpoints,
	protocols,
	type Lease,
	type ProviderName,
} from "../service/profiles";

function fixture() {
	const readiness: Record<string, string> = { asr: "ready", tts: "ready" };
	const current: Lease = {
		id: "connection1",
		request: {
			profile: "test-profile",
			client: "test",
			audience: "test",
			fullProfile: true,
			catalogRevision: "rev1",
		},
		agentProfile: "fixture-profile",
		startedAt: performance.now(),
		expiresAt: Date.now() + 900_000,
		providers: new Map(),
		catalogProviders: ["asr", "tts"].map((name) => ({
			name,
			protocol: protocols[name as ProviderName],
			endpoint: endpoints[name as ProviderName],
		})),
		useCount: 0,
		closing: false,
		idleAt: Date.now() + 900_000,
	};
	function bind(name: "asr" | "tts") {
		current.providers.set(name, {
			name,
			baseUrl: "http://127.0.0.1",
			model: "fixture-model",
			protocol: protocols[name],
			token: "fixture-token",
		});
	}
	bind("asr");
	bind("tts");
	return {
		readiness,
		bind,
		acquire: (name: "asr" | "tts") =>
			acquireProvider(
				current,
				name,
				async () =>
					Response.json({
						id: current.id,
						profile: current.request.profile,
						agentProfile: current.agentProfile,
						status: "ready",
						providers: current.catalogProviders!.map((p) => ({
							...p,
							readiness: readiness[String(p.name)],
						})),
					}),
				{ base: new URL("http://127.0.0.1"), extra: [] },
				freshSignal(),
			),
	};
}

afterEach(() => configureLogging({ level: "silent" }));

test("reused Provider logs readiness changes, not each request; connections stay independent", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	const entries = () =>
		lines
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === "larm.provider_readiness")
			.map(({ kind, next }) => ({ kind, next }));
	const f = fixture();
	const other = fixture();
	for (let i = 0; i < 5; i++) await f.acquire("asr");
	expect(entries()).toEqual([{ kind: "asr", next: "ready" }]);
	await f.acquire("tts");
	f.readiness.asr = "failed";
	await expect(f.acquire("asr")).rejects.toThrow("larm_provider_failed");
	f.readiness.asr = "ready";
	f.bind("asr");
	await f.acquire("asr");
	await other.acquire("asr");
	expect(entries()).toEqual([
		{ kind: "asr", next: "ready" },
		{ kind: "tts", next: "ready" },
		{ kind: "asr", next: "failed" },
		{ kind: "asr", next: "ready" },
		{ kind: "asr", next: "ready" },
	]);
});
