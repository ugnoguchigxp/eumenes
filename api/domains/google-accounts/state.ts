import type { Database } from "bun:sqlite";
import {
	GoogleAccountError,
	type GoogleAccountView,
	type GoogleProfile,
	type Tokens,
} from "./contracts";
import * as repository from "./repository";
import { random, seal, unseal } from "./secrets";
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
	viewRevision?: number;
	epoch: string;
	profile?: GoogleProfile;
	tokens?: Tokens;
	provider?: string;
	status: GoogleAccountView["status"];
	attempt?: Attempt;
	result?: GoogleAccountView["result"];
	retryAt?: number;
	revocations?: string[];
};
export const empty = (): State => ({ epoch: random(), status: "disconnected" });

/** Storage revisions protect writes; visible revisions protect user actions. */
export function createPersistence(getKey: () => Uint8Array | undefined) {
	const key = () => {
		const value = getKey();
		if (!value) throw new GoogleAccountError("unconfigured");
		return value;
	};
	function load(db: Database) {
		const row = repository.read(db);
		try {
			const state = row.sealed ? unseal<State>(row.sealed, key()) : empty();
			return {
				revision: row.revision,
				viewRevision: state.viewRevision ?? row.revision,
				state,
			};
		} catch {
			throw new GoogleAccountError("unconfigured");
		}
	}
	function write(db: Database, revision: number, state: State, visible = true) {
		const viewRevision = load(db).viewRevision + Number(visible);
		repository.save(db, revision, seal({ ...state, viewRevision }, key()));
	}

	return { load, write };
}
