import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	dot,
	hash,
	packVector,
	unpackVector,
	vectorSpaceKey,
	type VectorSpace,
} from "../../capabilities";
import {
	RECIPE_SUSPEND_AFTER,
	recipeProposal,
	type Recipe,
	type RecipeProposal,
} from "../contracts";
import type { RecipeRow } from "../repository";

const log = getLogger("toolchain-history");
const RECIPE_CANDIDATES = 3;

function recipe(row: RecipeRow): Recipe {
	return {
		id: row.id,
		toolchainId: row.toolchain_id,
		signature: row.signature,
		url: row.url,
		readHint: row.read_hint,
		state: row.state,
		successes: row.successes,
		failures: row.failures,
		consecutiveFailures: row.consecutive_failures,
		lastSuccessAt: row.last_success_at,
		lastFailureAt: row.last_failure_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
function trigramQuery(text: string) {
	const chars = [...text.normalize("NFKC").replace(/\s+/g, " ").trim()];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length && grams.size < 48; i++) {
		const gram = chars.slice(i, i + 3).join("");
		if (gram.trim().length === 3) grams.add(gram);
	}
	return [...grams]
		.map((g) => '"' + g.replaceAll('"', '""') + '"')
		.join(" OR ");
}
/** Saved fetch procedures of toolchains: matched by the sub-agent, kept by the host. */
export function createRecipes(
	store: SqliteStore,
	now: () => number,
	/** The stored request vector of a run (from the selection trace). */
	queryOfRunInTransaction: (
		db: Database,
		runId: string,
	) => { space: string; vector: Float32Array } | undefined,
) {
	/** Saved procedures of a toolchain that point at a URL (any state but disabled). */
	function recipesByUrlInTransaction(
		db: Database,
		toolchainId: string,
		url: string,
	) {
		return (
			db
				.query(
					"SELECT id FROM toolchain_recipes WHERE toolchain_id=? AND url=? AND state<>'disabled'",
				)
				.all(toolchainId, url) as { id: string }[]
		).map((r) => r.id);
	}
	/**
	 * Saved procedures for a request: trigram FTS over the signatures, plus similarity of the
	 * run's request vector to stored signature vectors. The sub-agent judges whether one matches.
	 */
	function findRecipesInTransaction(
		db: Database,
		input: { toolchainId: string; text: string; runId?: string },
	) {
		const ranked = new Map<string, number>();
		const query = trigramQuery(input.text);
		if (query)
			(
				db
					.query(
						"SELECT s.id FROM toolchain_recipe_search s JOIN toolchain_recipes r ON r.id=s.id WHERE toolchain_recipe_search MATCH ? AND r.toolchain_id=? AND r.state='active' ORDER BY bm25(toolchain_recipe_search) LIMIT 16",
					)
					.all(query, input.toolchainId) as { id: string }[]
			).forEach((row, i) =>
				ranked.set(row.id, (ranked.get(row.id) ?? 0) + 1 / (60 + i + 1)),
			);
		const asked = input.runId
			? queryOfRunInTransaction(db, input.runId)
			: undefined;
		if (asked)
			(
				db
					.query(
						"SELECT v.recipe_id,v.vector FROM toolchain_recipe_vectors v JOIN toolchain_recipes r ON r.id=v.recipe_id WHERE v.space=? AND r.toolchain_id=? AND r.state='active'",
					)
					.all(asked.space, input.toolchainId) as {
					recipe_id: string;
					vector: Uint8Array;
				}[]
			)
				.map((row) => ({
					id: row.recipe_id,
					score: dot(unpackVector(row.vector), asked.vector),
				}))
				.filter((x) => x.score > 0.75)
				.sort((a, b) => b.score - a.score)
				.slice(0, 16)
				.forEach((x, i) =>
					ranked.set(x.id, (ranked.get(x.id) ?? 0) + 1 / (60 + i + 1)),
				);
		const ids = [...ranked.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, RECIPE_CANDIDATES)
			.map(([id]) => id);
		return ids.flatMap((id) => {
			const row = db
				.query("SELECT * FROM toolchain_recipes WHERE id=?")
				.get(id) as RecipeRow | null;
			return row ? [recipe(row)] : [];
		});
	}
	/** Count one use of a procedure's URL; three failures in a row suspend it. */
	function recordRecipeResultInTransaction(
		db: Database,
		recipeId: string,
		ok: boolean,
	) {
		const at = now();
		if (ok)
			db.query(
				"UPDATE toolchain_recipes SET successes=successes+1,consecutive_failures=0,last_success_at=?,updated_at=? WHERE id=?",
			).run(at, at, recipeId);
		else {
			db.query(
				"UPDATE toolchain_recipes SET failures=failures+1,consecutive_failures=consecutive_failures+1,last_failure_at=?,updated_at=?,state=CASE WHEN state='active' AND consecutive_failures+1>=? THEN 'suspended' ELSE state END WHERE id=?",
			).run(at, at, RECIPE_SUSPEND_AFTER, recipeId);
			const row = db
				.query("SELECT state FROM toolchain_recipes WHERE id=?")
				.get(recipeId) as { state: string } | null;
			if (row?.state === "suspended")
				log.info("recipe.suspended", { recipeId });
		}
	}
	/**
	 * Save (or move to a new URL) the procedure for one signature. The caller has already checked
	 * that the URL was read in this task and that the answer cites it.
	 */
	function saveRecipeInTransaction(
		db: Database,
		toolchainId: string,
		proposal: RecipeProposal,
	) {
		const parsed = recipeProposal.parse(proposal);
		const at = now();
		const existing = db
			.query(
				"SELECT * FROM toolchain_recipes WHERE toolchain_id=? AND signature=?",
			)
			.get(toolchainId, parsed.signature) as RecipeRow | null;
		if (existing?.state === "disabled") return existing.id;
		const id = existing?.id ?? crypto.randomUUID();
		if (existing)
			db.query(
				"UPDATE toolchain_recipes SET url=?,read_hint=?,state='active',consecutive_failures=0,successes=successes+1,last_success_at=?,updated_at=? WHERE id=?",
			).run(parsed.url, parsed.readHint, at, at, id);
		else
			db.query(
				"INSERT INTO toolchain_recipes(id,toolchain_id,signature,url,read_hint,state,successes,last_success_at,created_at,updated_at) VALUES(?,?,?,?,?,'active',1,?,?,?)",
			).run(
				id,
				toolchainId,
				parsed.signature,
				parsed.url,
				parsed.readHint,
				at,
				at,
				at,
			);
		db.query("DELETE FROM toolchain_recipe_search WHERE id=?").run(id);
		db.query("INSERT INTO toolchain_recipe_search(id,content) VALUES(?,?)").run(
			id,
			parsed.signature,
		);
		log.info("recipe.saved", { recipeId: id, toolchainId });
		return id;
	}
	function pendingRecipeVectorsInTransaction(db: Database, space: VectorSpace) {
		const key = vectorSpaceKey(space);
		return (
			db
				.query(
					"SELECT r.id,r.signature,v.text_digest FROM toolchain_recipes r LEFT JOIN toolchain_recipe_vectors v ON v.recipe_id=r.id AND v.space=? WHERE r.state<>'disabled' LIMIT 256",
				)
				.all(key) as {
				id: string;
				signature: string;
				text_digest: string | null;
			}[]
		)
			.filter((r) => r.text_digest !== hash(r.signature))
			.map((r) => ({ recipeId: r.id, text: r.signature }));
	}
	function saveRecipeVectorsInTransaction(
		db: Database,
		space: VectorSpace,
		rows: Array<{ recipeId: string; text: string; vector: number[] }>,
	) {
		const key = vectorSpaceKey(space);
		for (const row of rows) {
			const current = db
				.query("SELECT signature FROM toolchain_recipes WHERE id=?")
				.get(row.recipeId) as { signature: string } | null;
			if (current?.signature !== row.text) continue;
			if (row.vector.length !== space.dimension)
				throw new Error("invalid_embedding_result");
			db.query(
				"INSERT INTO toolchain_recipe_vectors(recipe_id,space,text_digest,vector) VALUES(?,?,?,?) ON CONFLICT(recipe_id,space) DO UPDATE SET text_digest=excluded.text_digest,vector=excluded.vector",
			).run(row.recipeId, key, hash(row.text), packVector(row.vector));
		}
	}

	function listRecipes(toolchainId?: string) {
		return store.read((db) =>
			(
				db
					.query(
						"SELECT * FROM toolchain_recipes WHERE (?1 IS NULL OR toolchain_id=?1) ORDER BY updated_at DESC LIMIT 500",
					)
					.all(toolchainId ?? null) as RecipeRow[]
			).map(recipe),
		);
	}
	function setRecipeState(id: string, state: "active" | "disabled") {
		return store.write((db) => {
			const changed = db
				.query(
					"UPDATE toolchain_recipes SET state=?,consecutive_failures=CASE WHEN ?='active' THEN 0 ELSE consecutive_failures END,updated_at=? WHERE id=?",
				)
				.run(state, state, now(), id).changes;
			if (!changed) throw new Error("recipe_not_found");
		});
	}
	function deleteRecipe(id: string) {
		return store.write((db) => {
			db.query("DELETE FROM toolchain_recipe_vectors WHERE recipe_id=?").run(
				id,
			);
			db.query("DELETE FROM toolchain_recipe_search WHERE id=?").run(id);
			if (!db.query("DELETE FROM toolchain_recipes WHERE id=?").run(id).changes)
				throw new Error("recipe_not_found");
		});
	}
	return {
		recipesByUrlInTransaction,
		findRecipesInTransaction,
		recordRecipeResultInTransaction,
		saveRecipeInTransaction,
		pendingRecipeVectorsInTransaction,
		saveRecipeVectorsInTransaction,
		listRecipes,
		setRecipeState,
		deleteRecipe,
	};
}
