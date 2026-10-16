import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadDesktopClient,
	desktopRedirectUri,
} from "../service/desktop-client";
import { googleProviderFromEnv } from "../service/provider";
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(contents?: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-desktop-oauth-"));
	directories.push(dir);
	const file = join(dir, "distribution-client.json");
	if (contents !== undefined) writeFileSync(file, JSON.stringify(contents));
	return file;
}
const installed = {
	client_id: "desktop-fixture.apps.googleusercontent.com",
	client_secret: "desktop-fixture-credential",
};
test("a distributed desktop client enables login without per-user environment settings", () => {
	const file = fixture({
		installed: {
			...installed,
			auth_uri: "https://untrusted.example/",
			token_uri: "https://untrusted.example/token",
			redirect_uris: ["http://localhost"],
		},
	});
	const provider = googleProviderFromEnv({}, "http://127.0.0.1:42345", file)!;
	expect(provider).toBeDefined();
	const url = new URL(
		provider.authorization({
			state: "state",
			nonce: "nonce",
			verifier: "verifier",
			challenge: "challenge",
		}),
	);
	expect(url.origin).toBe("https://accounts.google.com");
	expect(url.searchParams.get("client_id")).toBe(installed.client_id);
	expect(url.searchParams.get("redirect_uri")).toBe(
		"http://127.0.0.1:42345/oauth/google/callback",
	);
	expect(url.searchParams.get("scope")).toBe("openid email profile");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(url.href).not.toContain(installed.client_secret);
});
test("a developer override replaces the bundled client without mixing credentials", () => {
	const bundled = fixture({ installed });
	const override = fixture({ installed: { client_id: "independent-client" } });
	expect(
		loadDesktopClient(
			{ EUMENES_GOOGLE_DESKTOP_CLIENT_FILE: override },
			bundled,
		),
	).toEqual({ clientId: "independent-client", clientSecret: undefined });
	expect(
		loadDesktopClient({ EUMENES_GOOGLE_DESKTOP_CLIENT_FILE: "  " }, bundled)
			?.clientId,
	).toBe(installed.client_id);
});
test("missing distribution config stays unconfigured and legacy Web credentials do not enable it", () => {
	const file = fixture();
	expect(
		googleProviderFromEnv({}, "http://127.0.0.1:5173", file),
	).toBeUndefined();
	expect(
		googleProviderFromEnv(
			{
				EUMENES_GOOGLE_CLIENT_ID: "web-client",
				EUMENES_GOOGLE_CLIENT_SECRET: "web-secret",
			},
			"http://127.0.0.1:5173",
			file,
		),
	).toBeUndefined();
	expect(() =>
		loadDesktopClient({ EUMENES_GOOGLE_DESKTOP_CLIENT_FILE: file }),
	).toThrow("config_invalid:EUMENES_GOOGLE_DESKTOP_CLIENT_FILE");
});
test("Web clients, malformed JSON, and incomplete credentials fail with sanitized errors", () => {
	const file = fixture();
	const inputs = [
		JSON.stringify({ web: installed }),
		JSON.stringify({ web: installed, installed }),
		JSON.stringify({ installed: { client_secret: "private-secret" } }),
		JSON.stringify({ installed: { client_id: "  " } }),
		JSON.stringify({ installed: { client_id: "client", client_secret: 42 } }),
		'{"installed":{"client_secret":"private-secret",',
	];
	for (const input of inputs) {
		writeFileSync(file, input);
		try {
			loadDesktopClient({}, file);
			throw new Error("accepted_invalid_config");
		} catch (error) {
			expect((error as Error).message).toBe(
				"config_invalid:EUMENES_GOOGLE_DESKTOP_CLIENT_FILE",
			);
		}
	}
});
test("desktop OAuth callbacks remain on the local browser origin, including its chosen port", () => {
	for (const origin of [
		"http://127.0.0.1:5173",
		"http://localhost:3000",
		"http://[::1]:42345",
	]) {
		expect(desktopRedirectUri(origin)).toBe(`${origin}/oauth/google/callback`);
	}
	for (const origin of [
		"https://example.com",
		"http://192.168.1.2:5173",
		"http://0.0.0.0:5173",
		"http://localhost.attacker.example",
		"http://user:secret@localhost:3000",
		"http://localhost:3000/?to=elsewhere",
		"http://localhost:3000/#fragment",
		"not-a-url",
	]) {
		expect(() => desktopRedirectUri(origin)).toThrow(
			"config_invalid:EUMENES_ORIGIN",
		);
	}
});
