import { expect } from "bun:test";
import { fixture, makeLarm, result } from "./larm.fixture";
/** Different Connection scopes and genuinely partial claims, like the public API. */
export function independent() {
	const fake = fixture();
	const readiness: Record<string, string> = {
		llm: "probing",
		asr: "ready",
		tts: "ready",
	};
	let status = "probing";
	const claims: string[][] = [],
		deleted: string[] = [],
		sent: string[] = [];
	let activeScope = "";
	const scopes = new Map<string, string>();
	let voiceProviders: unknown[] = [];
	let version = 1;
	let claimFault: string | undefined;
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const id = url.pathname.split("/")[3];
		if (init?.method === "DELETE") deleted.push(id!);
		if (url.pathname === "/v1/agent-connections" && init?.method === "POST") {
			expect(new Headers(init.headers).get("Prefer")).toBe(
				JSON.parse(String(init.body)).providers ? "wait=1" : null,
			);
			activeScope = JSON.parse(String(init.body)).providers
				? "primary"
				: "voice";
			scopes.set(activeScope, activeScope);
		}
		const actualScope = id === "primary" || id === "voice" ? id : activeScope;
		const mapped = new URL(url);
		mapped.pathname = mapped.pathname.replace(
			/\/(primary|voice)(\/|$)/,
			"/connection1$2",
		);
		if (/\/(llm|asr|tts)\/v1\//.test(url.pathname)) {
			const name = url.pathname.split("/")[1]!;
			sent.push(name);
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				`Bearer secret-${name}-${version}`,
			);
		}
		if (url.pathname === "/asr/v1/audio/transcriptions")
			return result({ text: "こんにちは" });

		let response = await fake.fetcher(mapped, init);
		if (url.pathname.endsWith("/renew") && response.ok) version++;
		if (
			!url.pathname.startsWith("/v1/agent-connections") ||
			response.status === 204
		)
			return response;
		const body = await response.json();
		body.id = actualScope;
		body.status = actualScope === "voice" ? status : "ready";
		if (url.pathname === "/v1/agent-connections" && actualScope === "voice")
			voiceProviders = structuredClone(body.providers);
		if (!url.pathname.endsWith("/claim") && actualScope === "voice")
			body.providers = structuredClone(voiceProviders);
		if (Array.isArray(body.providers))
			for (const p of body.providers)
				p.readiness = actualScope === "voice" ? readiness[p.name] : "ready";
		if (url.pathname.endsWith("/claim")) {
			body.status = "ready";
			const selected = JSON.parse(String(init?.body)).providers;
			expect(Array.isArray(selected)).toBe(true);
			expect(selected).toHaveLength(1);
			claims.push(selected);
			for (const name of selected)
				if (actualScope === "voice") expect(readiness[name]).toBe("ready");
			body.providers = body.providers.filter((p: { name: string }) =>
				selected.includes(p.name),
			);
			if (selected.includes(claimFault))
				return result({ error: "failed" }, 503);
		}
		response = result(body, response.status);
		return response;
	};
	return {
		larm: makeLarm(fetcher, 1_800_000),
		claims,
		deleted,
		sent,
		readiness,
		status: (s: string) => {
			status = s;
		},
		fault: (s?: string) => {
			claimFault = s;
		},
		scopes,
	};
}
