import { expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { createGoogleProvider } from "../service/provider";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
function setup(
	changes: Record<string, unknown> = {},
	badSignature = false,
	scope = "openid email profile",
) {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iss: "https://accounts.google.com",
		aud: "client-id",
		sub: "stable-id",
		email: "person@example.com",
		email_verified: true,
		name: "Person",
		nonce: "nonce",
		iat: now,
		exp: now + 3600,
		...changes,
	};
	const parts = [{ alg: "RS256", kid: "test-key" }, payload].map((v) =>
		Buffer.from(JSON.stringify(v)).toString("base64url"),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(parts.join("."));
	const jwt =
		parts.join(".") +
		"." +
		signer
			.sign(badSignature ? other.privateKey : keys.privateKey)
			.toString("base64url");
	const client = Object.assign(new OAuth2Client({ clientId: "client-id" }), {
		getToken: async () => ({
			tokens: {
				id_token: jwt,
				access_token: "access",
				refresh_token: "refresh",
				expiry_date: Date.now() + 3600_000,
				scope,
			},
		}),
		getFederatedSignonCertsAsync: async () => ({
			certs: {
				"test-key": keys.publicKey
					.export({ type: "spki", format: "pem" })
					.toString(),
			},
			format: "PEM",
		}),
	});
	return createGoogleProvider(
		{
			clientId: "client-id",
			clientSecret: "server-secret",
			redirectUri: "http://127.0.0.1:5173/oauth/google/callback",
		},
		() => client,
	);
}
test("authorization only requests basic identity with offline access, state, nonce and PKCE", () => {
	const provider = setup();
	const url = new URL(
		provider.authorization({
			state: "state",
			nonce: "nonce",
			verifier: "verifier",
			challenge: "challenge",
		}),
	);
	expect(url.origin).toBe("https://accounts.google.com");
	expect(url.searchParams.get("scope")).toBe("openid email profile");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(url.searchParams.get("code_challenge")).toBe("challenge");
	expect(url.searchParams.get("state")).toBe("state");
	expect(url.searchParams.get("nonce")).toBe("nonce");
	expect(url.searchParams.get("include_granted_scopes")).toBeNull();
	expect(url.href).not.toContain("server-secret");
});
test("valid signed identity is accepted and external avatar URLs are not exposed", async () => {
	expect(
		await setup({ picture: "https://untrusted.example/avatar" }).exchange(
			"code",
			"verifier",
			"nonce",
		),
	).toMatchObject({
		profile: { sub: "stable-id", email: "person@example.com" },
		tokens: { refresh: "refresh" },
	});
	expect(
		(
			await setup({ picture: "https://untrusted.example/avatar" }).exchange(
				"code",
				"verifier",
				"nonce",
			)
		).profile.picture,
	).toBeUndefined();
});
for (const [name, changes] of Object.entries({
	nonce: { nonce: "other" },
	audience: { aud: "other-client" },
	issuer: { iss: "https://evil.example" },
	expired: { exp: 1 },
	unverified: { email_verified: false },
	subject: { sub: "" },
})) {
	test(`rejects ${name} with sanitized errors`, async () => {
		await expect(
			setup(changes).exchange("secret-code", "secret-verifier", "nonce"),
		).rejects.toThrow(/invalid_authorization|provider_unavailable/);
	});
}
test("rejects forged signatures and unexpected service scopes", async () => {
	await expect(
		setup({}, true).exchange("code", "verifier", "nonce"),
	).rejects.toThrow("provider_unavailable");
	await expect(
		setup(
			{},
			false,
			"openid https://www.googleapis.com/auth/gmail.readonly",
		).exchange("code", "verifier", "nonce"),
	).rejects.toThrow("invalid_authorization");
});

test("Photos authorization requests only Picker scope in addition to identity and requires its actual grant", async () => {
	const scope =
		"https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
	const input = {
		state: "state",
		nonce: "nonce",
		verifier: "verifier",
		challenge: "challenge",
		photos: true,
	};
	expect(new URL(setup().authorization(input)).searchParams.get("scope")).toBe(
		`openid email profile ${scope}`,
	);
	await expect(
		setup().exchange("code", "verifier", "nonce", true),
	).rejects.toThrow("invalid_authorization");
	expect(
		(
			await setup({}, false, `openid email profile ${scope}`).exchange(
				"code",
				"verifier",
				"nonce",
				true,
			)
		).tokens.scopes,
	).toContain(scope);
});
