import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	selectionPageQuerySchema,
	recipePageQuerySchema,
	type SelectionPageQuery,
	type RecipePageQuery,
	type Selection,
	type Recipe,
} from "../contracts";
import type { SelectionRow, RecipeRow } from "../repository";

export function createHistoryPages(
	store: SqliteStore,
	selection: (row: SelectionRow) => Selection,
	recipe: (row: RecipeRow) => Recipe,
) {
	return {
		selectionPage: (input: SelectionPageQuery) => {
			const query = selectionPageQuerySchema.parse(input);
			const sorts = {
				createdAt: "created_at",
				process: "coalesce(function_name,decision)",
				outcome: "coalesce(outcome,'')",
			};
			return store.read((db) =>
				db.transaction(() => {
					const where =
						"WHERE instr(lower(coalesce(function_name,'')||' '||decision||' '||CASE decision WHEN 'toolchain' THEN 'ツールチェーンへ依頼' WHEN 'answer' THEN '直接回答・確認質問' WHEN 'rejected' THEN '出力が契約違反' ELSE '' END||' '||coalesce(request_text,'')||' '||coalesce(outcome,'')||' '||CASE outcome WHEN 'answered' THEN '回答できた' WHEN 'partial' THEN '一部回答' WHEN 'not_found' THEN '見つからない' WHEN 'clarification_required' THEN '確認が必要' WHEN 'failed' THEN '失敗' WHEN 'cancelled' THEN '取消' WHEN 'expired' THEN '期限切れ' WHEN 'completed' THEN '完了' ELSE '実行中' END||' '||coalesce(outcome_code,'')||' '||run_id),lower(?))>0";
					const total = (
						db
							.query(
								`SELECT count(*) AS total FROM toolchain_selections ${where}`,
							)
							.get(query.q) as { total: number }
					).total;
					const pageIndex = Math.min(
						query.pageIndex,
						Math.max(0, Math.ceil(total / query.pageSize) - 1),
					);
					const direction = query.desc ? "DESC" : "ASC";
					const items = (
						db
							.query(
								`SELECT * FROM toolchain_selections ${where} ORDER BY ${sorts[query.sort]} ${direction},id ${direction} LIMIT ? OFFSET ?`,
							)
							.all(
								query.q,
								query.pageSize,
								pageIndex * query.pageSize,
							) as SelectionRow[]
					).map(selection);
					return { ...query, pageIndex, total, items };
				})(),
			);
		},
		recipePage: (input: RecipePageQuery) => {
			const query = recipePageQuerySchema.parse(input);
			const sorts = {
				updatedAt: "updated_at",
				signature: "signature",
				state: "state",
				successes: "successes",
				failures: "failures",
			};
			return store.read((db) =>
				db.transaction(() => {
					const where =
						"WHERE instr(lower(signature||' '||url||' '||read_hint||' '||state||' '||CASE state WHEN 'active' THEN '有効' WHEN 'disabled' THEN '無効' WHEN 'suspended' THEN '停止中（取得に連続失敗）' ELSE '' END),lower(?))>0";
					const total = (
						db
							.query(`SELECT count(*) AS total FROM toolchain_recipes ${where}`)
							.get(query.q) as { total: number }
					).total;
					const pageIndex = Math.min(
						query.pageIndex,
						Math.max(0, Math.ceil(total / query.pageSize) - 1),
					);
					const direction = query.desc ? "DESC" : "ASC";
					const items = (
						db
							.query(
								`SELECT * FROM toolchain_recipes ${where} ORDER BY ${sorts[query.sort]} ${direction},id ${direction} LIMIT ? OFFSET ?`,
							)
							.all(
								query.q,
								query.pageSize,
								pageIndex * query.pageSize,
							) as RecipeRow[]
					).map(recipe);
					return { ...query, pageIndex, total, items };
				})(),
			);
		},
	};
}
