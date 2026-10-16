import type {
	WorldClaims,
	WorldClaimsContext,
	WorldDocuments,
} from "../../domains/world";
import { z } from "zod";
import type {
	ClaimContent,
	ClaimDetail,
	ClaimRow,
	ForgetView,
} from "../../domains/world/contracts/view";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const WORLD_ADAPTER_REF = "adapter:world@1";
const STATUS = "query:world.status@1";
const CLAIMS = "query:world.claims@1";
const FORGETS = "query:world.forgets@1";
const STATUS_COMPACT = "query:world.status@2";
const CLAIMS_PAGE = "query:world.claims-page@1";
const DOCUMENTS_PAGE = "query:world.documents-page@1";
const claimPageQuery = z.strictObject({
	pageIndex: z.number().int().min(0).max(100000).default(0),
	pageSize: z.union([z.literal(10), z.literal(25), z.literal(50)]).default(10),
	q: z.string().trim().max(200).default(""),
	sort: z
		.enum(["subject", "claim", "toneLabel", "originLabel", "freshnessLabel"])
		.default("subject"),
	desc: z.boolean().default(false),
});

/** What the World adapter reads; each is a public read operation of the World domain. */
export type WorldAdapterPorts = {
	claims: Pick<WorldClaims, "status" | "list" | "detail" | "forgets">;
	documents?: Pick<WorldDocuments, "pageInTransaction">;
	/** Who the screen shows: bound by the host, never by a request. */
	context: () => WorldClaimsContext;
};
/** Absent while World is configured OFF: the adapter is then unavailable and the screen is not offered. */
export type WorldAdapterPortsLookup = () => WorldAdapterPorts | undefined;

const toneLabels: Record<ClaimRow["tone"], string> = {
	adopted: "採用済み",
	measured: "実測（採用済み）",
	hypothesis: "仮説（採用しても未確認）",
	candidate: "候補（未採用）",
	disputed: "争い中",
};
const evidenceLabels: Record<ClaimRow["evidenceKinds"][number], string> = {
	user_statement: "本人の発言",
	document: "資料",
	runtime_measurement: "実測",
	assistant_summary: "アシスタントの要約",
};
const originLabels: Record<ClaimRow["origin"], string> = {
	user_report: "本人の報告",
	document_claim: "資料の主張",
	runtime_observation: "実行時の観測",
	model_hypothesis: "モデルの仮説",
};
const freshnessLabels: Record<ClaimRow["freshness"], string> = {
	fresh: "新しい",
	stale: "古い",
	unknown: "不明",
};
/** Forgetting: only `complete` may be read as done. */
const forgetLabels: Record<ForgetView["display"], string> = {
	pending: "処理中（完了ではありません）",
	awaiting_confirmation: "外部の削除の確認待ち（完了ではありません）",
	abandoned: "一部を実行できませんでした（完了ではありません）",
	complete: "完了",
};

function contentText(content: ClaimContent): string {
	if (content.kind === "relation")
		return `${content.relation} → ${content.objectId}`;
	const v = content.value;
	switch (v.kind) {
		case "string":
			return v.value;
		case "boolean":
			return v.value ? "はい" : "いいえ";
		case "number":
			return `${v.value}${v.unit ? ` ${v.unit}` : ""}`;
		case "entity":
			return v.entityId;
	}
}

const claimRow = (row: ClaimRow) => ({
	id: row.id,
	revision: row.revision,
	subject: row.target.subjectId,
	claim: `${row.claim.predicate} : ${contentText(row.claim.content)}`,
	adoption: row.adoption,
	toneLabel: toneLabels[row.tone],
	originLabel: originLabels[row.origin],
	evidenceLabel:
		row.evidenceKinds.map((kind) => evidenceLabels[kind]).join("、") || "なし",
	freshnessLabel: freshnessLabels[row.freshness],
});

const forgetRow = (view: ForgetView) => ({
	forgetId: view.forgetId,
	display: view.display,
	displayLabel: forgetLabels[view.display],
	state: view.state,
	blocked: view.blocked,
	rootCount: view.rootCount,
	createdAt: view.createdAt,
	updatedAt: view.updatedAt,
	// Only these are still moving; the screen re-reads the list while one is.
	inProgress:
		view.display === "pending" || view.display === "awaiting_confirmation",
});

const sourceStateLabels = {
	current: "現在の版",
	changed: "版が変わった",
	unavailable: "参照できない",
} as const;
const conditionLabels = {
	satisfied: "成立",
	violated: "不成立",
	unknown: "未確認",
} as const;
/** The claim's grounds, as bounded plain text for table cells (the legacy detail drawer's content). */
const DETAIL_LIMIT = 50;
const CELL_CHARS = 600;
const cell = (parts: string[]) => {
	const text = parts.join(" / ");
	return text === ""
		? "なし"
		: text.length > CELL_CHARS
			? `${text.slice(0, CELL_CHARS)}…`
			: text;
};
const sourceText = (source: { kind: string; id: string }, revision: string) =>
	`${source.kind} ${source.id}（版 ${revision.slice(0, 12)}）`;
function detailColumns(detail: ClaimDetail) {
	const evidence = (e: ClaimDetail["supports"][number]) =>
		`${evidenceLabels[e.kind]} — ${sourceText(e.source, e.source.revision)}`;
	return {
		condition: `${detail.condition.text}（${conditionLabels[detail.condition.evaluation]}）`,
		supports: cell(detail.supports.map(evidence)),
		refutations: cell([
			...detail.refutations.evidence.map(evidence),
			...detail.refutations.claims.map(
				(c) =>
					`別の主張 ${c.id}（版 ${c.revision}）${c.predicate ? ` : ${c.predicate}` : ""}`,
			),
		]),
		sourceVersions: cell(
			detail.sources.map(
				(s) =>
					`${sourceText(s, s.citedRevision)} — ${sourceStateLabels[s.state]}`,
			),
		),
		history:
			cell(
				detail.history.map(
					(h) =>
						`版${h.revision}: ${h.lifecycle} — ${contentText(h.content)}（${originLabels[h.origin]}）`,
				),
			) + (detail.historyTruncated ? "（古い版は省略）" : ""),
	};
}
const NO_DETAIL = {
	condition: "—",
	supports: "—",
	refutations: "—",
	sourceVersions: "—",
	history: "—",
};

/** Why a list cannot be shown, in words (an empty list would read as "nothing is held"). */
const unavailableText = (what: string, code: string) => {
	switch (code) {
		case "world_disabled":
			return `Worldがオフのため、${what}を表示できません`;
		case "world_unavailable":
			return `Worldを利用できる状態ではないため（起動の確認中、または忘却の処理中）、${what}を表示できません`;
		case "not_found":
			return `${what}を表示できる対象がありません`;
		default:
			return `${what}を表示できません（${code}）`;
	}
};

/** What the World adapter offers, without the domain (bundle checks, evaluation). View only: no operation. */
export const describeWorldAdapter = () => ({
	owner: "world",
	operations: new Map<
		string,
		{ inputSchemaRef: string; effect: "read" | "write" }
	>(),
	queries: new Set([
		STATUS,
		CLAIMS,
		FORGETS,
		STATUS_COMPACT,
		CLAIMS_PAGE,
		DOCUMENTS_PAGE,
	]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:world@1",
});

/**
 * The typed World adapter: status, the claim list and the forget list, read only (plan G3: claims are kept
 * by the memory steward; the owner can look but not change them, so the adapter has no operation).
 * The adapter is unavailable while World is OFF (no ports).
 * One Scope only: the screen shows the host-bound `context()` Scope and offers no Scope
 * choice (the legacy panel's choice appeared only with several Scopes, which this host has not).
 * The first 50 claims carry their grounds (condition, evidence, refutations, source
 * versions, history) as table columns; later rows show "—".
 */
export function createWorldAdapter(
	lookup: WorldAdapterPortsLookup,
): DomainAdapter {
	return {
		ref: WORLD_ADAPTER_REF,
		describe: describeWorldAdapter,
		availableInTransaction: () => lookup() !== undefined,
		snapshotInTransaction: () => ({ items: [] }),
		// View only: there is no operation to run and no receipt to read.
		invokeInTransaction() {
			throw new Error("capability_unavailable");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx, query, _target, params) {
			const ports = lookup();
			if (!ports) return null;
			const ctx = ports.context();
			switch (query) {
				case STATUS_COMPACT: {
					const status = ports.claims.status(ctx);
					const online = status.enabled && status.usable && status.gateOpen;
					return {
						revision: 0,
						data: {
							items: [
								{ id: "world", connection: online ? "online" : "offline" },
							],
						},
					};
				}
				case DOCUMENTS_PAGE: {
					if (!ports.documents || ctx.scopeKeys.length !== 1) return null;
					return {
						revision: 0,
						data: ports.documents.pageInTransaction(
							tx,
							{
								principal: ctx.principal,
								scopeKey: ctx.scopeKeys[0]!,
							},
							params ?? {},
						),
					};
				}
				case CLAIMS_PAGE: {
					const parsed = claimPageQuery.safeParse(params ?? {});
					if (!parsed.success) throw new Error("invalid_input");
					const list = ports.claims.list(ctx);
					if (list.status !== "ok")
						return {
							revision: 0,
							data: {
								items: [],
								total: 0,
								unavailable: list.code,
								unavailableText: unavailableText("主張の一覧", list.code),
							},
						};
					const { q, sort, desc, pageSize } = parsed.data;
					const needle = q.toLocaleLowerCase();
					const rows = list.value.items
						.map(claimRow)
						.filter(
							(row) =>
								!needle ||
								[
									row.subject,
									row.claim,
									row.toneLabel,
									row.originLabel,
									row.freshnessLabel,
								].some((value) => value.toLocaleLowerCase().includes(needle)),
						);
					rows.sort(
						(a, b) =>
							a[sort].localeCompare(b[sort], undefined, { numeric: true }) *
								(desc ? -1 : 1) || a.id.localeCompare(b.id),
					);
					const pageIndex = Math.min(
						parsed.data.pageIndex,
						Math.max(0, Math.ceil(rows.length / pageSize) - 1),
					);
					const items = rows
						.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
						.map((row) => {
							const detail = ports.claims.detail(ctx, { claimId: row.id });
							return {
								...row,
								...(detail.status === "ok"
									? detailColumns(detail.value)
									: NO_DETAIL),
							};
						});
					return {
						revision: 0,
						data: {
							total: rows.length,
							pageIndex,
							pageSize,
							items,
							complete: list.value.complete,
							stopped: list.value.stopped,
							...(list.value.complete
								? {}
								: {
										unavailableText:
											"読み取りの上限に達したため、一部の主張を表示しています。",
									}),
						},
					};
				}
				case STATUS: {
					const status = ports.claims.status(ctx);
					const list = ports.claims.list(ctx);
					const forgets = ports.claims.forgets(ctx);
					return {
						revision: 0,
						data: {
							items: [
								{
									id: "world",
									mode: status.mode,
									enabled: status.enabled,
									usable: status.usable,
									gateOpen: status.gateOpen,
									state: !status.enabled
										? "オフ（忘却の保護だけが動いています）"
										: !status.usable
											? "利用できる状態ではありません"
											: status.gateOpen
												? "オン"
												: "オン（Scopeの受付を閉じています）",
									listComplete:
										list.status === "ok" ? list.value.complete : undefined,
									stopped:
										list.status === "ok" ? list.value.stopped : undefined,
									// Absence from the list is not "no such claim" when a read budget stopped it.
									claimsNote:
										list.status !== "ok"
											? unavailableText("主張の一覧", list.code)
											: [
													list.value.complete
														? ""
														: "読み取りの上限に達したため、一部が表示されていません。表示がないことは「存在しない」ではありません",
													list.value.stopped > 0
														? `出典が変わったため、利用を止めている主張が${list.value.stopped}件あります`
														: "",
												]
													.filter(Boolean)
													.join("。") || "すべて表示しています",
									forgetsNote:
										forgets.status === "ok"
											? "—"
											: unavailableText("忘却の状況", forgets.code),
								},
							],
						},
					};
				}
				case CLAIMS: {
					const list = ports.claims.list(ctx);
					return {
						revision: 0,
						data:
							list.status === "ok"
								? {
										scopeKey: list.value.scopeKey,
										complete: list.value.complete,
										stopped: list.value.stopped,
										items: list.value.items.map((row, index) => {
											const detail =
												index < DETAIL_LIMIT
													? ports.claims.detail(ctx, { claimId: row.id })
													: undefined;
											return {
												...claimRow(row),
												...(detail?.status === "ok"
													? detailColumns(detail.value)
													: NO_DETAIL),
											};
										}),
									}
								: {
										items: [],
										unavailable: list.code,
										unavailableText: unavailableText("主張の一覧", list.code),
									},
					};
				}
				case FORGETS: {
					const forgets = ports.claims.forgets(ctx);
					return {
						revision: 0,
						data:
							forgets.status === "ok"
								? { items: forgets.value.forgets.map(forgetRow) }
								: {
										items: [],
										unavailable: forgets.code,
										unavailableText: unavailableText(
											"忘却の状況",
											forgets.code,
										),
									},
					};
				}
				default:
					return null;
			}
		},
		targetInput: () => ({}),
	};
}
