import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash, createPublicKey, verify } from "node:crypto";
import { startTrialProvider, scopes } from "./provider.mjs";
import { allowedAuthPath } from "./paths.mjs";

const origin = "https://trial.example.com",
	resource = `${origin}/mcp/dots/trial`,
	subject = "trial-owner",
	clientId = "trial-client",
	redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect",
	adminToken = randomBytes(32).toString("hex");
async function setup(t) {
	const service = await startTrialProvider({
		origin,
		resource,
		subject,
		clientId,
		adminToken,
		port: 0,
		adminPort: 0,
	});
	t.after(() => service.stop());
	const base = `http://127.0.0.1:${service.port}`,
		admin = `http://127.0.0.1:${service.adminPort}`,
		jar = new Map();
	const request = async (path, options = {}) => {
		const url = new URL(path, origin);
		const response = await fetch(`${base}${url.pathname}${url.search}`, {
			...options,
			headers: {
				cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
				...options.headers,
			},
			redirect: "manual",
		});
		for (const value of response.headers.getSetCookie()) {
			const cookie = value.split(";")[0];
			const equal = cookie.indexOf("=");
			jar.set(cookie.slice(0, equal), cookie.slice(equal + 1));
		}
		return response;
	};
	const adminCall = (path, options = {}) =>
		fetch(`${admin}${path}`, {
			...options,
			headers: { Authorization: `Bearer ${adminToken}`, ...options.headers },
		});
	const verifier = randomBytes(32).toString("base64url");
	const authParams = (overrides = {}) =>
		new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: scopes.join(" "),
			resource,
			state: randomBytes(16).toString("hex"),
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			...overrides,
		});
	const code = async () => {
		let response = await request(`/auth?${authParams()}`);
		for (let i = 0; i < 8; i++) {
			const location = response.headers.get("location");
			if (location?.startsWith(redirectUri)) {
				const callback = new URL(location);
				assert.equal(callback.searchParams.get("iss"), origin);
				assert.ok(callback.searchParams.get("code"));
				return callback.searchParams.get("code");
			}
			if (location) {
				response = await request(location);
				continue;
			}
			assert.equal(response.status, 200);
			const pending = (await (await adminCall("/pending")).json()).requests;
			assert.equal(pending.length, 1);
			assert.equal(pending[0].approved, false);
			assert.equal(pending[0].clientId, clientId);
			const uid = pending[0].uid;
			const denied = await request(`/interaction/${uid}`);
			assert.equal(denied.status, 200);
			assert.equal(denied.headers.get("location"), null);
			const approved = await adminCall("/approve", {
				method: "POST",
				body: JSON.stringify({ uid }),
			});
			assert.equal(approved.status, 200);
			response = await request(`/interaction/${uid}`);
		}
		assert.fail("authorization did not finish");
	};
	const token = (fields) =>
		request("/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId, resource, ...fields }),
		});
	return {
		service,
		request,
		adminCall,
		authParams,
		code,
		token,
		verifier,
		admin,
	};
}

test("real code + S256 + local owner approval yields signed owner/resource JWT; refresh rotates; code replay fails", async (t) => {
	const s = await setup(t);
	const metadata = await (
		await s.request("/.well-known/oauth-authorization-server")
	).json();
	assert.equal(metadata.issuer, origin);
	assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
	assert.equal(metadata.authorization_response_iss_parameter_supported, true);
	const code = await s.code();
	const response = await s.token({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: s.verifier,
	});
	assert.equal(response.status, 200);
	const tokens = await response.json();
	assert.ok(tokens.refresh_token);
	const [head, body, signature] = tokens.access_token.split(".");
	const header = JSON.parse(Buffer.from(head, "base64url")),
		claims = JSON.parse(Buffer.from(body, "base64url"));
	const jwks = await (await s.request("/jwks")).json();
	assert.ok(
		verify(
			"RSA-SHA256",
			Buffer.from(`${head}.${body}`),
			createPublicKey({
				key: jwks.keys.find((k) => k.kid === header.kid),
				format: "jwk",
			}),
			Buffer.from(signature, "base64url"),
		),
	);
	assert.equal(claims.iss, origin);
	assert.equal(claims.aud, resource);
	assert.equal(claims.sub, subject);
	assert.ok(claims.exp - claims.iat <= 900);
	for (const scope of scopes)
		assert.ok(claims.scope.split(" ").includes(scope));
	const refresh = await s.token({
		grant_type: "refresh_token",
		refresh_token: tokens.refresh_token,
	});
	assert.equal(refresh.status, 200);
	assert.notEqual((await refresh.json()).refresh_token, tokens.refresh_token);
	const replay = await s.token({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: s.verifier,
	});
	assert.equal(replay.status, 400);
	assert.equal((await replay.json()).error, "invalid_grant");
});
test("missing PKCE, wrong audience, unregistered redirect and wrong verifier cannot issue tokens", async (t) => {
	const s = await setup(t);
	for (const overrides of [
		{ resource: "https://other.example.com" },
		{ redirect_uri: "https://attacker.example.com/callback" },
		{ code_challenge: "", code_challenge_method: "" },
	]) {
		const response = await s.request(`/auth?${s.authParams(overrides)}`);
		assert.ok(
			response.status === 400 ||
				response.headers.get("location")?.includes("error="),
		);
	}
	const code = await s.code();
	const response = await s.token({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: randomBytes(32).toString("base64url"),
	});
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, "invalid_grant");
});
test("approval needs private loopback credential; public routing never exposes administration or product API", async (t) => {
	const s = await setup(t);
	assert.equal((await fetch(`${s.admin}/pending`)).status, 401);
	assert.equal(
		(await s.adminCall("/pending", { headers: { Origin: origin } })).status,
		401,
	);
	for (const path of [
		"/pending",
		"/approve",
		"/api/dots/configuration",
		"/keys",
		"/reg",
		"/interaction/a/approve",
	]) {
		assert.equal(allowedAuthPath(path, "GET"), false);
		assert.equal((await s.request(path)).status, 404);
	}
	assert.equal(allowedAuthPath("/token", "GET"), false);
	assert.equal(allowedAuthPath("/auth", "POST"), false);
});
