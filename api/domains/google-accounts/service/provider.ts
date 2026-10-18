import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import {
	GoogleAccountError,
	PHOTOS_SCOPE,
	type GoogleProvider,
	type Tokens,
} from "../contracts";
import { digest } from "./secrets";
import { desktopRedirectUri, loadDesktopClient } from "./desktop-client";
const scopes = ["openid", "email", "profile"];
const allowedScopes = new Set([
	...scopes,
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	PHOTOS_SCOPE,
]);
function failure(error: unknown): GoogleAccountError {
	const code = (error as { response?: { data?: { error?: unknown } } })
		?.response?.data?.error;
	return new GoogleAccountError(
		code === "invalid_grant" ? "invalid_grant" : "provider_unavailable",
	);
}
/** Only basic identity scopes; endpoints and identity verification belong to Google's library. */
export function createGoogleProvider(
	config: { clientId: string; clientSecret?: string; redirectUri: string },
	clientFactory = () =>
		new OAuth2Client({
			clientId: config.clientId,
			clientSecret: config.clientSecret,
			redirectUri: config.redirectUri,
			transporterOptions: { timeout: 15_000, retry: false },
		}),
): GoogleProvider {
	function tokenSet(
		tokens: {
			access_token?: string | null;
			refresh_token?: string | null;
			expiry_date?: number | null;
			scope?: string;
		},
		previous?: string,
	): Tokens {
		if (
			!tokens.access_token ||
			!(tokens.refresh_token || previous) ||
			!tokens.expiry_date ||
			!Number.isFinite(tokens.expiry_date)
		)
			throw new GoogleAccountError("invalid_authorization");
		if (
			tokens.scope &&
			tokens.scope.split(" ").some((s) => !allowedScopes.has(s))
		)
			throw new GoogleAccountError("invalid_authorization");
		return {
			access: tokens.access_token,
			refresh: tokens.refresh_token || previous!,
			expires: tokens.expiry_date,
			...(tokens.scope ? { scopes: tokens.scope.split(" ") } : {}),
		};
	}
	return {
		identity: digest(config.clientId + "\n" + config.redirectUri),
		authorization(input) {
			return clientFactory().generateAuthUrl({
				scope: input.photos ? [...scopes, PHOTOS_SCOPE] : scopes,
				access_type: "offline",
				prompt: "consent select_account",
				state: input.state,
				nonce: input.nonce,
				code_challenge: input.challenge,
				code_challenge_method: CodeChallengeMethod.S256,
			});
		},
		async exchange(code, verifier, nonce, photos = false) {
			try {
				const client = clientFactory();
				const { tokens } = await client.getToken({
					code,
					codeVerifier: verifier,
					redirect_uri: config.redirectUri,
				});
				if (!tokens.id_token)
					throw new GoogleAccountError("invalid_authorization");
				const ticket = await client.verifyIdToken({
					idToken: tokens.id_token,
					audience: config.clientId,
				});
				const profile = ticket.getPayload();
				if (
					!profile ||
					(profile as { nonce?: string }).nonce !== nonce ||
					!profile.sub ||
					!profile.email ||
					profile.email_verified !== true
				)
					throw new GoogleAccountError("invalid_authorization");
				let picture: string | undefined;
				if (profile.picture) {
					const url = new URL(profile.picture);
					if (
						url.protocol === "https:" &&
						(url.hostname === "googleusercontent.com" ||
							url.hostname.endsWith(".googleusercontent.com"))
					)
						picture = url.href;
				}
				const verifiedTokens = tokenSet(tokens);
				if (photos && !verifiedTokens.scopes?.includes(PHOTOS_SCOPE))
					throw new GoogleAccountError("invalid_authorization");
				return {
					profile: {
						sub: profile.sub,
						name: profile.name || profile.email,
						email: profile.email,
						...(picture ? { picture } : {}),
					},
					tokens: verifiedTokens,
				};
			} catch (error) {
				throw error instanceof GoogleAccountError ? error : failure(error);
			}
		},
		async refresh(token) {
			try {
				const client = clientFactory();
				client.setCredentials({ refresh_token: token });
				const { credentials } = await client.refreshAccessToken();
				return tokenSet(credentials, token);
			} catch (error) {
				throw error instanceof GoogleAccountError ? error : failure(error);
			}
		},
		async revoke(token) {
			try {
				await clientFactory().revokeToken(token);
			} catch (error) {
				// Already revoked is a successful disconnect; transport failures are retried.
				const data = (error as { response?: { data?: { error?: string } } })
					?.response?.data;
				if (data?.error !== "invalid_token") throw failure(error);
			}
		},
	};
}
export function googleProviderFromEnv(
	env: Record<string, string | undefined>,
	origin: string,
	bundledFile?: string,
): GoogleProvider | undefined {
	const client = loadDesktopClient(env, bundledFile);
	if (!client) return undefined;
	return createGoogleProvider({
		...client,
		redirectUri: desktopRedirectUri(origin),
	});
}
