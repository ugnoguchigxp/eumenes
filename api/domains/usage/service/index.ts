import type { Database } from "bun:sqlite";
import {
	rateInputSchema,
	usageQuerySchema,
	usageRange,
	type UsagePorts,
} from "../contracts";
import { rateRevision, ratesInTransaction } from "../repository";
import { decimal, liveCost } from "./cost";

const day = (n: number) => new Date(n + 9 * 3600000).toISOString().slice(0, 10);
const sum = (values: Array<number | null>) => {
	const known = values.filter((n): n is number => n !== null);
	return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
export function createUsage(
	ports: UsagePorts,
	clock = () => new Date().toISOString(),
) {
	function dashboardInTransaction(db: Database, raw: unknown) {
		const now = clock();
		const today = day(+new Date(now));
		const parsed = usageQuerySchema.safeParse(
			raw ?? { start: today.slice(0, 8) + "01", end: today },
		);
		if (!parsed.success) throw new Error("invalid_usage_query");
		const query = parsed.data;
		const { start, end } = usageRange(query);
		const rates = ratesInTransaction(db);
		const choices = ports.choices(db);
		const ongoing = (ports.activeLive?.(db) ?? [])
			.filter(
				(r) =>
					query.service !== "codex" &&
					(!query.model || r.model === query.model) &&
					(!query.connectionId || r.connectionId === query.connectionId),
			)
			.map((r) => ({
				...r,
				outsidePeriod:
					+new Date(r.startedAt) < start || +new Date(r.startedAt) >= end,
			}));
		const live = ports.live(db, start, end);
		const codex = ports.codex(db, start, end);
		const rows = [
			...live.map((r) => {
				const price = liveCost(
					r.seconds,
					r.model,
					+new Date(r.startedAt),
					rates,
				);
				return {
					id: r.id,
					service: "live" as const,
					model: r.model,
					requestedModel: r.model,
					connectionId: r.connectionId,
					connectionName: r.connectionName,
					started: r.startedAt,
					ended: r.endedAt,
					status: r.status,
					role: null as string | null,
					seconds: r.seconds,
					inputTokens: null as number | null,
					outputTokens: null as number | null,
					cacheReadTokens: null as number | null,
					cacheCreationTokens: null as number | null,
					reasoningTokens: null as number | null,
					confirmed: !!r.confirmed,
					test: !!r.test,
					estimate: price ? decimal(price.amount) : null,
					rateId: price?.rateId ?? null,
					reportedUsd: null as number | null,
				};
			}),
			...codex.map((r) => ({
				id: r.id,
				service: "codex" as const,
				model: r.model,
				requestedModel: r.requestedModel,
				connectionId: r.connectionId,
				connectionName: r.connectionName,
				started: new Date(r.started).toISOString(),
				ended: r.ended === null ? null : new Date(r.ended).toISOString(),
				status: r.status,
				role: r.role,
				seconds: null as number | null,
				inputTokens: r.inputTokens,
				outputTokens: r.outputTokens,
				cacheReadTokens: r.cacheReadTokens,
				cacheCreationTokens: r.cacheCreationTokens,
				reasoningTokens: r.reasoningTokens,
				confirmed: !!r.observed && r.status === "succeeded",
				test: false,
				estimate: null as string | null,
				rateId: null as string | null,
				reportedUsd: r.costUsd,
			})),
		].sort(
			(a, b) => b.started.localeCompare(a.started) || a.id.localeCompare(b.id),
		);
		const filtered = rows.filter(
			(r) =>
				(query.service === "all" || r.service === query.service) &&
				(!query.model || r.model === query.model) &&
				(!query.connectionId || r.connectionId === query.connectionId),
		);
		type Row = (typeof rows)[number];
		function aggregate(items: Row[]) {
			const lv = items.filter((r) => r.service === "live");
			const sdk = items.filter((r) => r.service === "codex");
			const amounts = lv.flatMap((r) =>
				r.estimate === null ? [] : [BigInt(r.estimate.replace(".", ""))],
			);
			return {
				count: items.length,
				liveCount: lv.length,
				codexCount: sdk.length,
				seconds: sum(lv.map((r) => r.seconds)),
				inputTokens: sum(sdk.map((r) => r.inputTokens)),
				outputTokens: sum(sdk.map((r) => r.outputTokens)),
				cacheReadTokens: sum(sdk.map((r) => r.cacheReadTokens)),
				cacheCreationTokens: sum(sdk.map((r) => r.cacheCreationTokens)),
				reasoningTokens: sum(sdk.map((r) => r.reasoningTokens)),
				estimate: amounts.length
					? decimal(amounts.reduce((a, b) => a + b, 0n))
					: null,
				reportedUsd: sum(sdk.map((r) => r.reportedUsd)),
				unconfirmed: items.filter((r) => !r.confirmed).length,
				missing: items.filter((r) =>
					r.service === "live"
						? r.seconds === null
						: r.inputTokens === null || r.outputTokens === null,
				).length,
				cacheMissing: sdk.filter((r) => r.cacheReadTokens === null).length,
				unpriced: lv.filter((r) => r.estimate === null).length,
				active: items.filter((r) =>
					["connecting", "active", "closing", "running"].includes(r.status),
				).length,
			};
		}
		const daily = [];
		for (let at = start; at < end; at += 86400000) {
			const date = day(at);
			daily.push({
				date,
				...aggregate(
					filtered.filter((r) => day(+new Date(r.started)) === date),
				),
			});
		}
		const groups = new Map<string, Row[]>();
		for (const row of filtered) {
			const key = JSON.stringify([
				row.service,
				row.model,
				row.connectionId,
				row.role,
			]);
			const group = groups.get(key) ?? [];
			group.push(row);
			groups.set(key, group);
		}
		const total = filtered.length;
		const pageIndex = Math.min(
			query.pageIndex,
			Math.max(0, Math.ceil(total / 25) - 1),
		);
		return {
			kind: "usage-dashboard" as const,
			revision: rateRevision(db),
			asOf: now,
			query: { ...query, pageIndex },
			timezone: "Asia/Tokyo",
			ongoing,
			summary: aggregate(filtered),
			daily,
			groups: [...groups.values()].map((items) => ({
				service: items[0]!.service,
				model: items[0]!.model,
				connectionName: items[0]!.connectionName,
				role: items[0]!.role,
				...aggregate(items),
			})),
			rows: filtered.slice(pageIndex * 25, (pageIndex + 1) * 25),
			total,
			pageSize: 25,
			rates,
			models: [
				...new Set([
					...choices.models,
					...rows.flatMap((r) => (r.model ? [r.model] : [])),
				]),
			].sort(),
			liveModels: [
				...new Set([
					...choices.liveModels,
					...live.flatMap((r) => (r.model ? [r.model] : [])),
				]),
			].sort(),
			connections: [
				...new Map(
					rows
						.filter((r) => r.connectionId)
						.map((r) => [
							r.connectionId!,
							{
								id: r.connectionId!,
								name: r.connectionName ?? r.connectionId!,
							},
						]),
				).values(),
			],
			currentCodexModel: choices.currentCodexModel,
		};
	}
	function saveRateInTransaction(
		db: Database,
		requestId: string,
		raw: unknown,
	) {
		const replay = db
			.query("SELECT receipt FROM usage_operations WHERE id=?")
			.get(requestId) as { receipt: string } | null;
		if (replay) return { receipt: JSON.parse(replay.receipt), replay: true };
		const parsed = rateInputSchema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_usage_rate");
		const input = parsed.data;
		if (input.expectedRevision !== rateRevision(db))
			throw new Error("usage_revision_conflict");
		// Models come from saved settings or observed Live records; this is a contract check, not semantic classification.
		if (!ports.choices(db).liveModels.includes(input.model))
			throw new Error("usage_model_unknown");
		const effective = new Date(input.effectiveFrom).toISOString();
		if (
			db
				.query("SELECT 1 FROM usage_rates WHERE model=? AND effective_from=?")
				.get(input.model, effective)
		)
			throw new Error("usage_rate_conflict");
		const id = crypto.randomUUID();
		db.query("INSERT INTO usage_rates VALUES(?,?,?,?,?,?)").run(
			id,
			input.model,
			input.amount,
			effective,
			input.source,
			clock(),
		);
		const receipt = {
			id: requestId,
			action: "rate_saved",
			revision: rateRevision(db),
			rateId: id,
		};
		db.query("INSERT INTO usage_operations VALUES(?,?)").run(
			requestId,
			JSON.stringify(receipt),
		);
		return { receipt, replay: false };
	}
	return {
		dashboardInTransaction,
		saveRateInTransaction,
		readInTransaction(db: Database, id: string) {
			const row = db
				.query("SELECT receipt FROM usage_operations WHERE id=?")
				.get(id) as { receipt: string } | null;
			return row ? JSON.parse(row.receipt) : null;
		},
	};
}
export type UsageService = ReturnType<typeof createUsage>;
