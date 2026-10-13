import type { SqliteStore } from "../../../infrastructure/sqlite";

/** Isolated fixtures only; uses the owning inference tables in the single writer. */
export async function seedUsageFixture(store: SqliteStore, count = 125) {
	const at = Date.now();
	await store.write((db) => {
		for (let i = 0; i < count; i++) {
			const key = String(i).padStart(3, "0"),
				id = "usage-" + key;
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES(?,?,?,?,?)",
			).run(id, "fixture-" + key, "llm", "{}", at);
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,model,status,started,ended,accepted,input_tokens,output_tokens) VALUES(?,?,?,?,?,?,?,?,?,?)",
			).run(
				id,
				id,
				"larm",
				"fixture-model-" + key,
				"succeeded",
				at - count * 1000 + i * 1000,
				at,
				1,
				120,
				48,
			);
		}
	});
}
