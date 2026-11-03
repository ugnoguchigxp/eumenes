import { routingExportSecrets } from "../../domains/settings";
import { exportRedactor } from "./router-export-safety";
import type { Hono } from "hono";
import { z } from "zod";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { parseQuery } from "../../infrastructure/http";
import { routingExportCards } from "../../domains/capabilities";
import {
	routingExportRecords,
	routerExportSchema,
	routerExportSinceSchema,
	type RouterExport,
} from "../../domains/toolchain-history";
import { routingExportUtterance } from "../../domains/conversation";
import {
	routingExportRuns,
	routingExportFixedCards,
} from "../../domains/dialogue";
import {
	vectorSpaceKey,
	type VectorSpaceShape,
} from "../../infrastructure/vector";
import { resolve } from "node:path";

const querySchema = z
	.object({
		since: routerExportSinceSchema.optional(),
		withEmbeddings: z.enum(["true", "false"]).optional(),
	})
	.strict();
const iso = (n: number) => new Date(n).toISOString();
const resultOf = (outcome: string | null) =>
	outcome === "completed" || outcome === "answered"
		? "success"
		: outcome === "failed"
			? "failure"
			: outcome === "cancelled"
				? "cancelled"
				: null;

/** One readonly SQLite transaction: cards and history cannot straddle concurrent writes. No services are executed. */
export function createRouterExport(
	store: Pick<SqliteStore, "readSnapshot">,
	secrets: readonly string[] = [],
) {
	return (
		options: { since?: string; withEmbeddings?: boolean } = {},
	): RouterExport => {
		const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: resolve(import.meta.dir, "../../.."),
		});
		const status = Bun.spawnSync(["git", "status", "--porcelain"], {
			cwd: resolve(import.meta.dir, "../../.."),
		});
		const snapshot = store.readSnapshot((db) => {
			const since = options.since ? Date.parse(options.since) : 0;
			const { cards, embeddings } = routingExportCards(
				db,
				!!options.withEmbeddings,
			);
			const records = routingExportRecords(db, since);
			const runs = routingExportRuns(db, since);
			const byRun = new Map(runs.map((run) => [run.id, run]));
			const selections = new Map(
				records.selections.map((row) => [row.run_id, row]),
			);
			const traces = new Map(records.traces.map((row) => [row.run_id, row]));
			const ids = new Set([
				...byRun.keys(),
				...selections.keys(),
				...traces.keys(),
			]);
			const utterances: RouterExport["utterances"] = [];
			const choices: RouterExport["choices"] = [];
			for (const turnId of ids) {
				const run = byRun.get(turnId),
					selection = selections.get(turnId),
					trace = traces.get(turnId);
				const conversationId =
					run?.conversation_id ??
					trace?.conversation_id ??
					selection!.conversation_id;
				const messageId = run?.input_message_id ?? trace?.message_id ?? null;
				const words = routingExportUtterance(
					db,
					conversationId,
					messageId,
					turnId,
				);
				// Retraction/missing input is not restored from a trace's redundant text.
				if (!words.text && !selection && !trace) continue;
				utterances.push({
					conversationId,
					turnId,
					...words,
					text: words.text === null ? null : (trace?.query_text ?? words.text),
					activeToolchainId: null,
					activeTaskId: null,
					resourceKinds: run?.resourceKinds ?? null,
				});
				if (!selection && !trace) continue;
				const router = trace?.trace.mode === "on" && trace.trace.row !== 0;
				const retrieved = new Map<string, { similarity: number | null }>(
					(selection ? JSON.parse(selection.candidates_json) : []).map(
						(candidate: { toolchainId: string; similarity: number | null }) => [
							candidate.toolchainId,
							candidate,
						],
					),
				);
				const candidates =
					router || !selection
						? trace!.trace.candidates.map((c, i) => ({
								id: c.id,
								rank: i + 1,
								similarity: retrieved.get(c.id)?.similarity ?? null,
								probability: c.p,
							}))
						: (
								JSON.parse(selection!.candidates_json) as Array<{
									toolchainId: string;
									rank: number;
									similarity: number | null;
								}>
							).map((c) => ({
								id: c.toolchainId,
								rank: c.rank,
								similarity: c.similarity,
								probability: null,
							}));
				const selectedId = router
					? trace!.decided_id === "conversation.respond"
						? "none"
						: trace!.decided_id
					: selection
						? selection.decision === "answer"
							? "none"
							: selection.toolchain_id
						: null;
				choices.push({
					turnId,
					candidates,
					selectedId,
					route: router ? "router" : selection ? "llm" : null,
					result: resultOf(selection?.outcome ?? null),
					recordedOutcome: selection?.outcome ?? null,
					routerMode: trace?.trace.mode ?? null,
				});
			}
			const spaceInfo = new Map<string, VectorSpaceShape>();
			for (const row of records.spaces) {
				const space = JSON.parse(row.query_space_json) as VectorSpaceShape;
				if (space && vectorSpaceKey(space) === row.query_space)
					spaceInfo.set(row.query_space, space);
			}
			for (const vector of embeddings)
				vector.modelId = spaceInfo.get(vector.spaceId)?.modelId ?? null;
			const spaces = new Map(
				embeddings.map((v) => [
					v.spaceId,
					{ spaceId: v.spaceId, modelId: v.modelId, dimension: v.dimension },
				]),
			);
			const corrections = records.corrections.map((row) => ({
				id: row.id,
				turnId: row.run_id,
				wrongId: row.wrong_id,
				rightId: row.right_id,
				state: row.state,
				timestamp: iso(row.created_at),
				updatedAt: iso(row.updated_at),
			}));
			return {
				secrets: routingExportSecrets(db),
				cards: [...cards, ...routingExportFixedCards()],
				utterances,
				choices,
				corrections,
				embeddings,
				spaces: [...spaces.values()],
			};
		});
		const unavailable: RouterExport["manifest"]["unavailableFields"] = [
			{
				field: "cards.updatedAt",
				reason:
					"定義の改訂作成日時しか保存されず、有効状態を含む最終更新日時は保存されていない",
			},
			{
				field: "utterances.activeToolchainId / activeTaskId",
				reason:
					"ルーティング時点の状態スナップショットが保存されていない。現在の状態から復元しない",
			},
			{
				field: "manifest.embeddingModel",
				reason:
					"現在の埋め込みサービスのモデル名はDBに保存されていない。書き出しでは外部サービスへ接続しない",
			},
			{
				field: "cards (dynamic work/pending/redirect)",
				reason:
					"仕事・承認・訂正候補は各ターンの状態から生成され、当時の説明文は保存されていない。choicesには保存済みの候補IDを残す",
			},
		];
		const data = routerExportSchema.parse({
			...snapshot,
			manifest: {
				schemaVersion: 1,
				withEmbeddings: !!options.withEmbeddings,
				commitSha:
					revision.exitCode === 0 ? revision.stdout.toString().trim() : null,
				dirty: status.exitCode === 0 ? !!status.stdout.length : null,
				exportedAt: new Date().toISOString(),
				since: options.since ?? null,
				counts: {
					cards: snapshot.cards.length,
					utterances: snapshot.utterances.length,
					choices: snapshot.choices.length,
					corrections: snapshot.corrections.length,
					embeddings: snapshot.embeddings.length,
				},
				embeddingModel: null,
				embeddingSpaces: snapshot.spaces,
				unavailableFields: unavailable,
			},
		});
		// Record every absent exported field, including optional card declarations and missing retained input.
		for (const file of [
			"cards",
			"utterances",
			"choices",
			"corrections",
			"embeddings",
		] as const) {
			const counts = new Map<string, number>();
			const scan = (value: unknown, path: string) => {
				if (value === null) counts.set(path, (counts.get(path) ?? 0) + 1);
				else if (Array.isArray(value))
					value.forEach((item) => scan(item, path));
				else if (value && typeof value === "object")
					for (const [key, item] of Object.entries(value))
						scan(item, path ? `${path}.${key}` : key);
			};
			for (const row of data[file]) scan(row, "");
			for (const [key, count] of counts) {
				const existing = unavailable.find(
					(item) => item.field === `${file}.${key}`,
				);
				if (existing) {
					existing.count = count;
					continue;
				}
				unavailable.push({
					field: `${file}.${key}`,
					count,
					reason:
						file === "embeddings"
							? "ベクトルには空間のハッシュのみ保存。対応するモデル名を持つRouter記録が残っていない"
							: file === "choices"
								? key === "candidates.similarity"
									? "この候補の埋め込み類似度が記録されていない"
									: key === "candidates.probability"
										? "旧LLM経路は候補の確率を保存していない"
										: key === "routerMode"
											? "このターンに保存済みRouter記録がない"
											: key === "selectedId"
												? "選択が拒否されたか、候補が未決定"
												: "記録がないか、成功・失敗・取消に確定できない（recordedOutcomeは元の状態を保持）"
								: file === "utterances"
									? "当時の状態や直前の発言が保存されていない、または発言が削除済み"
									: "元の定義に宣言がない、または固定の会話・記憶候補にこの項目は存在しない",
				});
			}
		}
		data.manifest.unavailableFields = unavailable;
		const redactor = exportRedactor([
			...secrets,
			...snapshot.secrets,
			...Object.entries(process.env)
				.filter(
					([key]) =>
						key.startsWith("EUMENES_") ||
						/TOKEN|SECRET|PASSWORD|API_?KEY/i.test(key),
				)
				.flatMap(([, value]) => (value ? [value] : [])),
		]);
		const clean = routerExportSchema.parse(redactor.scrub(data));
		if (redactor.count())
			clean.manifest.unavailableFields.push({
				field: "redacted text",
				reason: "認証・接続情報、EUMENES環境変数の値を除去した文字列",
				count: redactor.count(),
			});
		return clean;
	};
}

export function registerRouterExport(
	app: Hono,
	exportSnapshot: ReturnType<typeof createRouterExport>,
) {
	app.get("/api/router-export", (c) => {
		const q = parseQuery(c, querySchema, { code: "invalid_request" });
		if (!q.ok) return q.response;
		return c.json(
			exportSnapshot({
				since: q.data.since,
				withEmbeddings: q.data.withEmbeddings === "true",
			}),
		);
	});
}
