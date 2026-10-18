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
	photosAuthorized?: boolean;
	result?: "connected" | "cancelled" | "failed" | "expired";
};
export const PHOTOS_SCOPE =
	"https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
export type Tokens = {
	refresh: string;
	access: string;
	expires: number;
	scopes?: string[];
};
export type Authorization = {
	state: string;
	nonce: string;
	verifier: string;
	challenge: string;
	photos?: boolean;
};
export interface GoogleProvider {
	readonly identity: string;
	authorization(input: Authorization): string;
	exchange(
		code: string,
		verifier: string,
		nonce: string,
		photos?: boolean,
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

export { photosView, type PhotosView } from "./photos";
