import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	GoogleAccountError,
	PHOTOS_SCOPE,
	type GoogleAccountView,
	type GoogleProvider,
} from "../contracts";
import { random } from "./secrets";
import { createPersistence, empty } from "./state";
import { createAuthorization } from "./authorization";
import { createPhotos } from "./photos";
export function createGoogleAccounts(
	store: SqliteStore,
	options: {
		key: () => Uint8Array | undefined;
		provider?: GoogleProvider;
		now?: () => number;
		secureCookies?: boolean;
		fetch?: typeof fetch;
	},
) {
	const now = options.now ?? Date.now;
	const provider = options.provider;
	const persistence = createPersistence(options.key);
	const { load, write } = persistence;
	const { begin, finish, settle } = createAuthorization(
		store,
		persistence,
		provider,
		now,
	);
	function viewInTransaction(db: Database): GoogleAccountView {
		const { viewRevision: revision, state: s } = load(db);
		const status =
			s.status === "connected" && s.provider !== provider?.identity
				? "reconnect"
				: s.status;
		return {
			revision,
			configured: !!provider && !!options.key(),
			status,
			...(s.profile ? { profile: s.profile } : {}),
			pending: !!s.attempt && s.attempt.expires > now(),
			photosAuthorized:
				status === "connected" && !!s.tokens?.scopes?.includes(PHOTOS_SCOPE),
			result:
				s.attempt && s.attempt.expires <= now()
					? "expired"
					: s.result === "connected" && status !== "connected"
						? undefined
						: s.result,
		};
	}
	async function cancel(expectedRevision: number) {
		await store.write((db) => {
			const saved = load(db);
			if (
				saved.viewRevision !== expectedRevision ||
				saved.state.status === "disconnecting" ||
				!saved.state.attempt
			)
				throw new GoogleAccountError("conflict");
			write(db, saved.revision, {
				...saved.state,
				epoch: random(),
				attempt: undefined,
				result: "cancelled",
			});
		});
	}
	let revocation: Promise<void> | undefined;
	function revoke() {
		if (!revocation)
			revocation = performRevocation().finally(() => {
				revocation = undefined;
			});
		return revocation;
	}
	async function performRevocation() {
		await settle();
		const saved = store.read(load),
			s = saved.state;
		if (s.status !== "disconnecting") return;
		if (!provider) throw new GoogleAccountError("unconfigured");
		const tokens = new Set([
			...(s.tokens ? [s.tokens.refresh] : []),
			...(s.revocations ?? []),
		]);
		for (const token of tokens) await provider.revoke(token);
		await store.write((db) => {
			const current = load(db);
			if (current.state.epoch === s.epoch) write(db, current.revision, empty());
		});
	}
	async function disconnect(expectedRevision: number) {
		if (!provider) throw new GoogleAccountError("unconfigured");
		await store.write((db) => {
			const saved = load(db);
			if (
				saved.viewRevision !== expectedRevision ||
				saved.state.status === "disconnecting"
			)
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
			tokens.scopes ??= s.tokens.scopes;
			await store.write((db) => {
				const current = load(db);
				if (current.revision === saved.revision)
					write(
						db,
						current.revision,
						{ ...s, tokens, retryAt: undefined },
						false,
					);
			});
		} catch (error) {
			await store.write((db) => {
				const current = load(db);
				if (current.revision !== saved.revision) return;
				const invalid =
					error instanceof GoogleAccountError && error.code === "invalid_grant";
				write(
					db,
					current.revision,
					{
						...s,
						status:
							invalid && s.status === "connected" ? "reconnect" : s.status,
						retryAt: now() + 60_000,
					},
					invalid && s.status === "connected",
				);
			});
		}
	}
	return {
		photos: createPhotos({
			store,
			persistence,
			provider,
			now,
			maintain,
			fetch: options.fetch,
		}),
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
