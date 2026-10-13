import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	usagePageQuerySchema,
	usageSchema,
	type UsagePageQuery,
	type Usage,
} from "../contracts";

const columns = {
	started: "a.started",
	purpose: "r.purpose",
	source: "a.source",
	model: "coalesce(a.model,'不明')",
	status: "a.status",
};
const from =
	"FROM inference_attempts a JOIN inference_requests r ON r.id=a.request_id";
const select =
	"SELECT a.id,a.request_id AS requestId,r.subject,r.purpose,a.source,a.model,a.status,a.reason,a.started,a.ended,a.accepted,a.input_tokens AS inputTokens,a.output_tokens AS outputTokens,a.provider_details AS providerDetails";
const decodeRaw = (row: unknown) => {
	const value = row as Record<string, unknown>;
	return {
		...value,
		providerDetails: JSON.parse(String(value.providerDetails)),
	} as Omit<Usage, "model"> & { model: string | null };
};
const decode = (row: unknown) => {
	const value = decodeRaw(row);
	return usageSchema.parse({ ...value, model: value.model ?? "不明" });
};

/** Queries apply to the complete retained dataset; sort columns never come from raw SQL input. */
export function createUsageReader(store: SqliteStore) {
	return {
		usage: () =>
			store.read((db) =>
				db
					.query(
						`${select} ${from} WHERE r.subject NOT LIKE 'probe:%' ORDER BY a.started DESC LIMIT 100`,
					)
					.all()
					.map(decodeRaw),
			),
		usagePage: (input: UsagePageQuery) => {
			const query = usagePageQuerySchema.parse(input);
			return store.read((db) =>
				db.transaction(() => {
					const where =
						"WHERE r.subject NOT LIKE 'probe:%' AND instr(lower(r.purpose||' '||CASE r.purpose WHEN 'llm' THEN '会話' WHEN 'asr' THEN '聞き取り' WHEN 'tts' THEN '読み上げ' ELSE '' END||' '||a.source||' '||coalesce(a.model,'不明')||' '||a.status||' '||CASE WHEN a.accepted<>0 THEN '採用済み' ELSE a.status END||' '||coalesce(a.reason,'')),lower(?))>0";
					const total = (
						db
							.query(`SELECT count(*) AS total ${from} ${where}`)
							.get(query.q) as { total: number }
					).total;
					const pageIndex = Math.min(
						query.pageIndex,
						Math.max(0, Math.ceil(total / query.pageSize) - 1),
					);
					const direction = query.desc ? "DESC" : "ASC";
					const items = db
						.query(
							`${select} ${from} ${where} ORDER BY ${columns[query.sort]} ${direction},a.id ${direction} LIMIT ? OFFSET ?`,
						)
						.all(query.q, query.pageSize, pageIndex * query.pageSize)
						.map(decode);
					return { ...query, pageIndex, total, items };
				})(),
			);
		},
	};
}
