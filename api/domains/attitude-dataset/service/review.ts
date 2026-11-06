import type { SqliteStore } from "../../../infrastructure/sqlite";
import { reviewSchema, type Sample } from "../contracts";
import * as records from "../repository/records";
import { containsCredential } from "./privacy";
import { exportSchema } from "./schema";
import { groupSplit } from "./split";

import { datasetReport } from "./report";
export function createDatasetReview(deps: {
	target: number;
	store: SqliteStore;
	path: string;
	control: () => NonNullable<ReturnType<typeof records.readControl>>;
	units: () => ReturnType<typeof records.listUnits>;
	samples: () => Sample[];
	volatileErrors: () => number;
}) {
	const { target, store, path, control, units, samples, volatileErrors } = deps;

	function status() {
		const all = units(),
			data = all
				.filter((u) => u.sample)
				.map((u) => JSON.parse(u.sample!) as Sample);
		const byReason: Record<string, number> = {};
		all
			.filter((u) => u.reason)
			.forEach((u) => (byReason[u.reason!] = (byReason[u.reason!] ?? 0) + 1));
		return {
			enabled: !!control().enabled,
			target,
			successful: data.length,
			unreviewed: data.filter((s) => s.review_status === "unreviewed").length,
			reviewed: data.filter((s) => s.review_status === "reviewed").length,
			held: data.filter((s) => s.review_status === "held").length,
			skipped: all.filter((u) => u.reason?.startsWith("skip:")).length,
			skip_reasons: byReason,
			pending: all.filter((u) => u.status === "pending").length,
			failed: all.filter((u) => u.status === "failed").length,
			storage_errors: Math.max(
				volatileErrors(),
				store.read((db) => records.readErrorCount(db)!.count),
			),
			path,
			score_notice:
				"合成データ由来の暫定校正。実会話の正解確率ではありません。",
		};
	}
	const report = () => datasetReport(samples(), status);
	return {
		status,
		report,
		list: () =>
			samples().map(
				({ sample_id, review_status, revision, granularity, chunk_order }) => ({
					sample_id,
					review_status,
					revision,
					granularity,
					chunk_order,
				}),
			),
		get(id: string, blind = true) {
			const sample = samples().find((s) => s.sample_id === id);
			if (!sample) return null;
			if (!blind) return sample;
			const {
				decision: _decision,
				adopted: _adopted,
				selected_delivery: _selected,
				rejection_reason: _reason,
				criteria: _criteria,
				candidate_order: _order,
				...rest
			} = sample;
			return rest;
		},
		async review(id: string, body: unknown) {
			const parsed = reviewSchema.safeParse(body);
			if (!parsed.success) throw new Error("invalid_review");
			if (
				containsCredential(
					[parsed.data.correction_reason, parsed.data.template_group_id]
						.filter(Boolean)
						.join("\n"),
				)
			)
				throw new Error("invalid_review_sensitive_text");
			return store.write((db) => {
				const row = records.readUnit(db, id);
				if (!row?.sample) throw new Error("invalid_sample");
				const sample = JSON.parse(row.sample) as Sample;
				const { revision, ...review } = parsed.data;
				if (sample.revision !== revision) throw new Error("revision_conflict");
				const updated = {
					...sample,
					...review,
					revision: revision + 1,
					split: null,
				};
				// Any review/group change invalidates all existing split assignments.
				for (const row of records.listSamples(db)) {
					const s = JSON.parse(row.sample!) as Sample;
					s.split = null;
					records.saveSample(db, JSON.stringify(s), row.id);
				}
				records.saveSample(db, JSON.stringify(updated), id);
				return {
					sample_id: id,
					revision: updated.revision,
					review_status: updated.review_status,
				};
			});
		},
		async split() {
			return store.write((db) => {
				const data = records
					.listSamplesOrdered(db)
					.map((r) => JSON.parse(r.sample!) as Sample);
				const result = groupSplit(data);
				for (const sample of data) {
					sample.split = result.assigned.get(sample.sample_id) ?? null;
					records.saveSample(db, JSON.stringify(sample), sample.sample_id);
				}
				return {
					counts: result.counts,
					groups: result.groups,
					warning:
						result.groups < 3
							? "独立グループが3未満です。会話・テンプレートを分割せず、追加収集してください。"
							: null,
				};
			});
		},
		export() {
			const reviewed = samples().filter((s) => s.review_status === "reviewed");
			if (reviewed.some((s) => !s.split))
				throw new Error("invalid_split_required");
			return {
				partitions: Object.fromEntries(
					["train", "calibration", "eval"].map((split) => [
						split,
						reviewed
							.filter((s) => s.split === split)
							.map((s) => JSON.stringify(s))
							.join("\n") +
							(reviewed.some((s) => s.split === split) ? "\n" : ""),
					]),
				),
				jsonl:
					reviewed.map((s) => JSON.stringify(s)).join("\n") +
					(reviewed.length ? "\n" : ""),
				report: report(),
				schema: exportSchema,
			};
		},
	};
}
