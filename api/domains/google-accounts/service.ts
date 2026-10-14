import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	GoogleAccountError,
	type GoogleAccountView,
	type GoogleProfile,
	type GoogleProvider,
	type Tokens,
} from "./contracts";
import * as repository from "./repository";
import { digest, random, seal, unseal } from "./secrets";
type Attempt = {
	state: string;
	browser: string;
	nonce: string;
	verifier: string;
	expires: number;
	provider: string;
	epoch: string;
	consumed?: boolean;
};
type State = {
	epoch: string;
	profile?: GoogleProfile;
	tokens?: Tokens;
	provider?: string;
	status: GoogleAccountView["status"];
	attempt?: Attempt;
	result?: GoogleAccountView["result"];
	retryAt?: number;
};
const empty = (): State => ({ epoch: random(), status: "disconnected" });
export function createGoogleAccounts(
	store: SqliteStore,
	options: {
		key: () => Uint8Array | undefined;
		provider?: GoogleProvider;
		now?: () => number;
		secureCookies?: boolean;
	},
) {
	const now = options.now ?? Date.now;
	const provider = options.provider;
	const key = () => {
		const value = options.key();
		if (!value) throw new GoogleAccountError("unconfigured");
		return value;
	};
	function load(db: Database) {
		const row = repository.read(db);
		try {
			return {
				revision: row.revision,
				state: row.sealed ? unseal<State>(row.sealed, key()) : empty(),
			};
		} catch {
			throw new GoogleAccountError("unconfigured");
		}
	}
	function write(db: Database, revision: number, state: State) {
		repository.save(db, revision, seal(state, key()));
	}
	function viewInTransaction(db: Database): GoogleAccountView {
		try {
			const { revision, state: s } = load(db);
			return {
				revision,
				configured: !!provider && !!options.key(),
				status:
					s.status === "connected" && s.provider !== provider?.identity
						? "reconnect"
						: s.status,
				...(s.profile ? { profile: s.profile } : {}),
				pending: !!s.attempt && s.attempt.expires > now(),
				result: s.attempt && s.attempt.expires <= now() ? "expired" : s.result,
			};
		} catch {
			return {
				revision: repository.read(db).revision,
				configured: false,
				status: "disconnected",
				pending: false,
			};
		}
	}
	async function begin(expectedRevision: number) {
		if (!provider) throw new GoogleAccountError("unconfigured");
		const state = random(),
			browser = random(),
			verifier = random(),
			nonce = random();
		const url = provider.authorization({
			state,
			nonce,
			verifier,
			challenge: digest(verifier),
		});
		await store.write((db) => {
			const saved = load(db);
			if (
				saved.revision !== expectedRevision ||
				saved.state.status === "disconnecting"
			)
				throw new GoogleAccountError("conflict");
			const epoch = random();
			write(db, saved.revision, {
				...saved.state,
				epoch,
				result: undefined,
				attempt: {
					state: digest(state),
					browser: digest(browser),
					nonce,
					verifier,
					expires: now() + 600_000,
					provider: provider.identity,
					epoch,
				},
			});
		});
		return { url, browser, state };
	}
	async function finish(input: {
		state: string;
		browser: string;
		code?: string;
		denied?: boolean;
	}) {
		if (!provider) throw new GoogleAccountError("unconfigured");
		const attempt = await store.write((db) => {
			const saved = load(db),
				a = saved.state.attempt;
			if (
				!a ||
				a.consumed ||
				a.expires <= now() ||
				a.state !== digest(input.state) ||
				a.browser !== digest(input.browser) ||
				a.provider !== provider.identity
			)
				throw new GoogleAccountError("invalid_authorization");
			write(db, saved.revision, {
				...saved.state,
				attempt: input.denied ? undefined : { ...a, consumed: true },
				result: input.denied ? "cancelled" : undefined,
			});
			return a;
		});
		if (input.denied) return "cancelled" as const;
		try {
			if (!input.code) throw new GoogleAccountError("invalid_authorization");
			const result = await provider.exchange(
				input.code,
				attempt.verifier,
				attempt.nonce,
			);
			await store.write((db) => {
				const saved = load(db),
					s = saved.state;
				if (
					s.epoch !== attempt.epoch ||
					!s.attempt ||
					s.attempt.expires <= now()
				)
					throw new GoogleAccountError("conflict");
				// Reconnection must restore the same stable Google identity, never silently switch users.
				if (s.profile && s.profile.sub !== result.profile.sub)
					throw new GoogleAccountError("invalid_authorization");
				write(db, saved.revision, {
					epoch: random(),
					profile: result.profile,
					tokens: result.tokens,
					provider: provider.identity,
					status: "connected",
					result: "connected",
				});
			});
			return "connected" as const;
		} catch {
			await store.write((db) => {
				const saved = load(db);
				if (saved.state.epoch === attempt.epoch)
					write(db, saved.revision, {
						...saved.state,
						attempt: undefined,
						result: "failed",
					});
			});
			return "failed" as const;
		}
	}
	async function cancel(expectedRevision: number) {
		await store.write((db) => {
			const saved = load(db);
			if (saved.revision !== expectedRevision)
				throw new GoogleAccountError("conflict");
			write(db, saved.revision, {
				...saved.state,
				epoch: random(),
				attempt: undefined,
				result: "cancelled",
			});
		});
	}
	async function revoke() {
		const saved = store.read(load),
			s = saved.state;
		if (s.status !== "disconnecting") return;
		if (!provider) throw new GoogleAccountError("unconfigured");
		if (s.tokens) await provider.revoke(s.tokens.refresh);
		await store.write((db) => {
			const current = load(db);
			if (current.state.epoch === s.epoch) write(db, current.revision, empty());
		});
	}
	async function disconnect(expectedRevision: number) {
		if (!provider) throw new GoogleAccountError("unconfigured");
		await store.write((db) => {
			const saved = load(db);
			if (saved.revision !== expectedRevision)
				throw new GoogleAccountError("conflict");
			write(db, saved.revision, {
				...saved.state,
				epoch: random(),
				attempt: undefined,
				result: undefined,
				status: "disconnecting",
			});
		});
		await revoke();
	}
	async function maintain() {
		if (!provider || !options.key()) return;
		const saved = store.read(load),
			s = saved.state;
		if (s.attempt && s.attempt.expires <= now()) {
			await store.write((db) => {
				const current = load(db);
				if (current.revision === saved.revision)
					write(db, current.revision, {
						...s,
						epoch: random(),
						attempt: undefined,
						result: "expired",
					});
			});
			return;
		}
		if ((s.retryAt ?? 0) > now()) return;
		try {
			if (s.status === "disconnecting") {
				await revoke();
				return;
			}
			if (
				s.status !== "connected" ||
				s.provider !== provider.identity ||
				!s.tokens ||
				s.tokens.expires > now() + 120_000 ||
				s.attempt
			)
				return;
			const tokens = await provider.refresh(s.tokens.refresh);
			await store.write((db) => {
				const current = load(db);
				if (current.revision === saved.revision)
					write(db, current.revision, { ...s, tokens, retryAt: undefined });
			});
		} catch (error) {
			await store.write((db) => {
				const current = load(db);
				if (current.revision !== saved.revision) return;
				const invalid =
					error instanceof GoogleAccountError && error.code === "invalid_grant";
				write(db, current.revision, {
					...s,
					status: invalid && s.status === "connected" ? "reconnect" : s.status,
					retryAt: now() + 60_000,
				});
			});
		}
	}
	return {
		secureCookies: options.secureCookies ?? false,
		viewInTransaction,
		view: () => store.read(viewInTransaction),
		begin,
		finish,
		cancel,
		disconnect,
		maintain,
	};
}
export type GoogleAccounts = ReturnType<typeof createGoogleAccounts>;
