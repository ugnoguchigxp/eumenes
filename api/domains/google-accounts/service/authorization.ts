import type { SqliteStore } from "../../../infrastructure/sqlite";
import { GoogleAccountError, type GoogleProvider } from "../contracts";
import { digest, random } from "./secrets";
import type { createPersistence } from "./state";
export function createAuthorization(
	store: SqliteStore,
	persistence: ReturnType<typeof createPersistence>,
	provider: GoogleProvider | undefined,
	now: () => number,
) {
	const { load, write } = persistence;
	const exchanges = new Set<Promise<"connected" | "cancelled" | "failed">>();
	function finish(input: Parameters<typeof completeAuthorization>[0]) {
		const operation = completeAuthorization(input);
		exchanges.add(operation);
		const remove = () => {
			exchanges.delete(operation);
		};
		void operation.then(remove, remove);
		return operation;
	}
	async function begin(expectedRevision: number, photos = false) {
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
			photos,
		});
		await store.write((db) => {
			const saved = load(db);
			if (
				saved.viewRevision !== expectedRevision ||
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
					photos,
				},
			});
		});
		return { url, browser, state };
	}
	async function completeAuthorization(input: {
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
			write(
				db,
				saved.revision,
				{
					...saved.state,
					attempt: input.denied ? undefined : { ...a, consumed: true },
					result: input.denied ? "cancelled" : undefined,
				},
				!!input.denied,
			);
			return a;
		});
		if (input.denied) return "cancelled" as const;
		try {
			if (!input.code) throw new GoogleAccountError("invalid_authorization");
			const result = await provider.exchange(
				input.code,
				attempt.verifier,
				attempt.nonce,
				attempt.photos,
			);
			const connected = await store.write((db) => {
				const saved = load(db),
					s = saved.state;
				if (s.status === "disconnecting") {
					write(
						db,
						saved.revision,
						{
							...s,
							revocations: [...(s.revocations ?? []), result.tokens.refresh],
						},
						false,
					);
					return false;
				}
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
				return true;
			});
			return connected ? ("connected" as const) : ("failed" as const);
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

	// Disconnect blocks new authorizations before waiting, so the set can only drain.
	return { begin, finish, settle: () => Promise.allSettled(exchanges) };
}
