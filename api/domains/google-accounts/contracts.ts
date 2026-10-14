export type GoogleProfile = {
	sub: string;
	name: string;
	email: string;
	picture?: string;
};
export type GoogleAccountView = {
	revision: number;
	configured: boolean;
	status: "disconnected" | "connected" | "reconnect" | "disconnecting";
	profile?: GoogleProfile;
	pending: boolean;
	result?: "connected" | "cancelled" | "failed" | "expired";
};
export type Tokens = { refresh: string; access: string; expires: number };
export type Authorization = {
	state: string;
	nonce: string;
	verifier: string;
	challenge: string;
};
export interface GoogleProvider {
	readonly identity: string;
	authorization(input: Authorization): string;
	exchange(
		code: string,
		verifier: string,
		nonce: string,
	): Promise<{ profile: GoogleProfile; tokens: Tokens }>;
	refresh(token: string): Promise<Tokens>;
	revoke(token: string): Promise<void>;
}
export class GoogleAccountError extends Error {
	constructor(
		public readonly code:
			| "unconfigured"
			| "conflict"
			| "invalid_authorization"
			| "invalid_grant"
			| "provider_unavailable",
	) {
		super(code);
	}
}
