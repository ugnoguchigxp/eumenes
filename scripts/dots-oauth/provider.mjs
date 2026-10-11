import { createServer } from "node:http";
import { randomBytes, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { Provider, errors } from "oidc-provider";
import { allowedAuthPath } from "./paths.mjs";

export const scopes = ["dots:read", "dots:report", "dots:events"];
export const chatgptRedirect =
	"https://chatgpt.com/connector_platform_oauth_redirect";
const escape = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
const same = (a, b) => {
	const left = Buffer.from(a),
		right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};
/** Trial only: protocol handling is delegated to oidc-provider. Approval is local and explicit. */
export async function startTrialProvider({
	origin,
	resource,
	subject,
	clientId,
	adminToken,
	port = 8800,
	adminPort = 8802,
	until = Date.now() + 7200000,
	redirectUris = [chatgptRedirect],
}) {
	const publicUrl = new URL(origin);
	if (
		publicUrl.protocol !== "https:" ||
		publicUrl.origin !== origin ||
		new URL(resource).origin !== origin ||
		!subject ||
		!clientId ||
		adminToken.length < 32 ||
		until <= Date.now() ||
		until > Date.now() + 7201000
	)
		throw new Error("invalid_trial_configuration");
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = {
		...privateKey.export({ format: "jwk" }),
		kid: randomBytes(16).toString("hex"),
		alg: "RS256",
		use: "sig",
	};
	const pending = new Map();
	const prune = () => {
		for (const [uid, entry] of pending)
			if (entry.expiresAt <= Date.now()) pending.delete(uid);
	};
	const provider = new Provider(origin, {
		clients: [
			{
				client_id: clientId,
				application_type: "web",
				redirect_uris: redirectUris,
				token_endpoint_auth_method: "none",
				response_types: ["code"],
				grant_types: ["authorization_code", "refresh_token"],
			},
		],
		jwks: { keys: [jwk] },
		cookies: {
			keys: [randomBytes(32).toString("hex")],
			long: { maxAge: 7200000 },
			short: { maxAge: 600000 },
		},
		responseTypes: ["code"],
		scopes: ["openid", ...scopes],
		claims: { openid: ["sub"] },
		pkce: { required: () => true },
		ttl: {
			AccessToken: 900,
			AuthorizationCode: 60,
			RefreshToken: 7200,
			Interaction: 600,
			Session: 7200,
			Grant: 7200,
		},
		features: {
			devInteractions: { enabled: false },
			userinfo: { enabled: false },
			revocation: { enabled: true },
			resourceIndicators: {
				enabled: true,
				defaultResource: () => resource,
				useGrantedResource: () => true,
				getResourceServerInfo(_ctx, indicator, client) {
					if (indicator !== resource || client.clientId !== clientId)
						throw new errors.InvalidTarget();
					return {
						scope: scopes.join(" "),
						audience: resource,
						accessTokenFormat: "jwt",
						accessTokenTTL: Math.max(
							1,
							Math.min(900, Math.floor((until - Date.now()) / 1000)),
						),
						jwt: { sign: { alg: "RS256" } },
					};
				},
			},
		},
		interactions: {
			url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
		},
		issueRefreshToken: (_ctx, client) =>
			client.grantTypeAllowed("refresh_token"),
		findAccount: (_ctx, id) =>
			id === subject
				? { accountId: subject, claims: () => ({ sub: subject }) }
				: undefined,
	});
	provider.proxy = true;
	provider.on("server_error", () =>
		process.stderr.write("OAuth protocol handler error\n"),
	);
	const callback = provider.callback();
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url, origin).pathname;
			if (!allowedAuthPath(path, req.method)) {
				res.writeHead(404).end();
				return;
			}
			if (Date.now() >= until && path !== "/jwks") {
				res.writeHead(410).end("Trial expired");
				return;
			}
			// This loopback listener is used only behind the dedicated allowlist proxy.
			req.headers["x-forwarded-proto"] = "https";
			req.headers["x-forwarded-host"] = publicUrl.host;
			req.headers.host = publicUrl.host;
			if (path === "/.well-known/oauth-authorization-server")
				req.url = "/.well-known/openid-configuration";
			if (path.startsWith("/interaction/")) {
				const details = await provider.interactionDetails(req, res);
				if (
					details.params.client_id !== clientId ||
					!redirectUris.includes(details.params.redirect_uri) ||
					!["login", "consent"].includes(details.prompt.name)
				)
					throw new Error("trial_interaction_denied");
				const targets = [details.params.resource ?? resource].flat();
				if (targets.some((target) => target !== resource))
					throw new Error("trial_resource_denied");
				const requested = String(details.params.scope ?? "")
					.split(" ")
					.filter(Boolean);
				if (requested.some((scope) => !["openid", ...scopes].includes(scope)))
					throw new Error("trial_scope_denied");
				prune();
				const fingerprint = JSON.stringify([
					details.params,
					details.prompt.name,
				]);
				const previous = pending.get(details.uid);
				if (previous?.approved && previous.fingerprint === fingerprint) {
					pending.delete(details.uid);
					let result;
					if (details.prompt.name === "login")
						result = {
							login: {
								accountId: subject,
								remember: false,
								amr: ["local_device_approval"],
							},
						};
					else {
						if (details.session?.accountId !== subject)
							throw new Error("trial_owner_denied");
						const grant = details.grantId
							? await provider.Grant.find(details.grantId)
							: new provider.Grant({ accountId: subject, clientId });
						if (details.prompt.details.missingOIDCScope)
							grant.addOIDCScope(
								details.prompt.details.missingOIDCScope.join(" "),
							);
						if (details.prompt.details.missingOIDCClaims)
							grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
						for (const [indicator, values] of Object.entries(
							details.prompt.details.missingResourceScopes ?? {},
						)) {
							if (
								indicator !== resource ||
								values.some((value) => !scopes.includes(value))
							)
								throw new Error("trial_scope_denied");
							grant.addResourceScope(indicator, values.join(" "));
						}
						result = { consent: { grantId: await grant.save() } };
					}
					await provider.interactionFinished(req, res, result, {
						mergeWithLastSubmission: details.prompt.name === "consent",
					});
					return;
				}
				if (!previous && pending.size >= 32) {
					res.writeHead(429).end();
					return;
				}
				pending.set(details.uid, {
					uid: details.uid,
					clientId,
					redirectUri: details.params.redirect_uri,
					resource,
					scopes: requested,
					prompt: details.prompt.name,
					fingerprint,
					expiresAt: Math.min(until, Date.now() + 300000),
					approved: false,
				});
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"Content-Security-Policy":
						"default-src 'none'; frame-ancestors 'none'",
					Refresh: "3",
				});
				res.end(
					`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Eumenes dots 接続承認待ち</title><h1>このPCで接続を承認してください</h1><p>試験専用のChatGPT接続です。公開画面からは承認できません。</p><p>照合ID: ${escape(details.uid)}</p><p>対象: ${escape(resource)}</p><p>許可: ${escape(requested.join(" "))}</p></html>`,
				);
				return;
			}
			callback(req, res);
		} catch {
			if (!res.headersSent) res.writeHead(400, { "Cache-Control": "no-store" });
			res.end("OAuth request rejected");
		}
	});
	const admin = createServer(async (req, res) => {
		try {
			const address = req.socket.localAddress;
			if (
				address !== "127.0.0.1" ||
				req.headers.origin ||
				req.headers.forwarded ||
				req.headers["x-forwarded-for"] ||
				!same(req.headers.authorization ?? "", `Bearer ${adminToken}`)
			) {
				res.writeHead(401).end();
				return;
			}
			prune();
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("Content-Type", "application/json");
			if (req.method === "GET" && req.url === "/pending") {
				res.end(
					JSON.stringify({
						requests: [...pending.values()].map(
							({ fingerprint: _fingerprint, ...entry }) => entry,
						),
					}),
				);
				return;
			}
			if (
				req.method === "POST" &&
				req.url === "/approve" &&
				Date.now() < until
			) {
				let body = "";
				for await (const chunk of req) {
					body += chunk;
					if (body.length > 1024) throw new Error("too_large");
				}
				const { uid } = JSON.parse(body),
					entry = pending.get(uid);
				if (!entry || entry.expiresAt <= Date.now()) {
					res.writeHead(409).end();
					return;
				}
				entry.approved = true;
				res.end(JSON.stringify({ approved: uid, prompt: entry.prompt }));
				return;
			}
			res.writeHead(404).end();
		} catch {
			res.writeHead(400).end();
		}
	});
	const listen = (instance, value) =>
		new Promise((resolve, reject) => {
			instance.once("error", reject);
			instance.listen(value, "127.0.0.1", resolve);
		});
	await listen(server, port);
	try {
		await listen(admin, adminPort);
	} catch (error) {
		await new Promise((resolve) => server.close(resolve));
		throw error;
	}
	return {
		provider,
		port: server.address().port,
		adminPort: admin.address().port,
		stop: async () => {
			server.closeAllConnections();
			admin.closeAllConnections();
			await Promise.all([
				new Promise((resolve) => server.close(resolve)),
				new Promise((resolve) => admin.close(resolve)),
			]);
		},
	};
}
