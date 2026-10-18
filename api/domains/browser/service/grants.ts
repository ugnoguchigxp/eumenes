import type { Database } from "bun:sqlite";
import { GRANT_MS, activeTaskStates, type GrantProvenance } from "../contracts";
import {
	type GrantRow,
	grantRow,
	insertGrant,
	ownedTask,
	useGrantRow,
} from "../repository";
import type { Ctx } from "./context";

/** Width, case, spacing and the separators people add to numbers do not change what was asked. */
const squash = (s: string) =>
	s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\-ー‐–—,，、/／]+/g, "");

function originOf(raw: string) {
	try {
		const u = new URL(raw);
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return u.origin;
	} catch {
		return null;
	}
}

const QUOTE_MIN = 2;
const QUOTE_VALUE_FACTOR = 4;
const QUOTE_VALUE_SLACK = 32;

type GrantInput = { value: string; origin: string; purpose: string };

/**
 * Input values a task may type (spec §5.3, user decision 2026-10-18). A value gets a ref only from the current
 * request or from the user's approval. The model quotes the passage of the request the value was taken from and
 * gives the value it derived from it (a paraphrased search term is allowed, so the value itself need not appear
 * in the request); the host checks that the quote is in the request. A quote can only be found in the request
 * text: nothing a page, an observation or another conversation produced can supply one.
 */
export function createGrants(ctx: Ctx) {
	function create(
		db: Database,
		owner: string,
		taskId: string,
		provenance: GrantProvenance,
		input: GrantInput,
	) {
		const task = ownedTask(db, taskId, owner);
		if (!activeTaskStates.includes(task.state))
			throw new Error("task_not_active");
		const origin = originOf(input.origin);
		if (!origin || !input.value || input.value.length > 2000 || !input.purpose)
			throw new Error("grant_invalid");
		const id = crypto.randomUUID();
		insertGrant(
			db,
			{
				id,
				task_id: taskId,
				origin,
				purpose: input.purpose.slice(0, 60),
				provenance,
				value: input.value,
				expires_at: Math.min(ctx.now() + GRANT_MS, task.deadline),
			},
			ctx.now(),
		);
		return { inputValueRef: id };
	}
	return {
		/** `quote` is the passage of the request the value was taken from; `value` may be reformatted from it. */
		fromRequestInTransaction(
			db: Database,
			owner: string,
			taskId: string,
			input: GrantInput & { quote: string },
		) {
			const task = ownedTask(db, taskId, owner);
			const quote = squash(input.quote);
			// A reformatted value is allowed, but a value much longer than the passage it came from, or a
			// passage too short to mean anything, is not a quotation of the request.
			if (
				quote.length < QUOTE_MIN ||
				input.value.length >
					QUOTE_VALUE_FACTOR * quote.length + QUOTE_VALUE_SLACK ||
				!squash(task.request).includes(quote)
			)
				throw new Error("grant_source_mismatch");
			return create(db, owner, taskId, "request", input);
		},
		/** Only the user's own approval path (the screen) calls this. */
		userApprovedInTransaction: (
			db: Database,
			owner: string,
			taskId: string,
			input: GrantInput,
		) => create(db, owner, taskId, "user_approved", input),
		/** The value for one use: same task, same site, same purpose, still valid. */
		useInTransaction(
			db: Database,
			taskId: string,
			ref: string,
			origin: string,
			purpose: string,
		): string {
			const g: GrantRow | null = grantRow(db, ref);
			if (
				!g ||
				g.task_id !== taskId ||
				g.revoked_at !== null ||
				g.value === null
			)
				throw new Error("grant_not_found");
			if (g.expires_at <= ctx.now()) throw new Error("grant_expired");
			if (g.origin !== origin || g.purpose !== purpose.slice(0, 60))
				throw new Error("grant_mismatch");
			useGrantRow(db, ref);
			return g.value;
		},
	};
}
export type Grants = ReturnType<typeof createGrants>;
export { originOf };
