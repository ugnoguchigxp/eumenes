import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	WorldClaims,
	WorldClaimsContext,
	ClaimFailure,
} from "../domains/world";
import type {
	ClaimContent,
	ClaimRow,
	ForgetView,
} from "../domains/world/contracts/view";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const WORLD_ADAPTER_REF = "adapter:world@1";
const STATUS = "query:world.status@1";
const CLAIMS = "query:world.claims@1";
const FORGETS = "query:world.forgets@1";
const REASONS = "query:world.reason-messages@1";
/** How many of the person's latest statements are offered as the reason of a change. */
const REASON_CHOICES = 20;

const claimId = z.string().min(1).max(256);
const revision = z.number().int().min(1);
const reasonMessageId = z.string().min(1).max(256);
const correct = z.strictObject({
	claimId,
	expectedRevision: revision,
	reasonMessageId,
	valueKind: z.enum(["string", "boolean", "number"]),
	value: z.string().min(1).max(1000),
	unit: z.string().max(40).optional(),
});
const retract = z.strictObject({
	claimId,
	expectedRevision: revision,
	reasonMessageId,
});
const forget = z.strictObject({ claimId, expectedRevision: revision });

/** What the World adapter reads and changes; each is a public operation of the World domain. */
export type WorldAdapterPorts = {
	claims: Pick<
		WorldClaims,
		| "status"
		| "list"
		| "forgets"
		| "correctInTransaction"
		| "retractInTransaction"
		| "forgetInTransaction"
		| "forgetStatusInTransaction"
	>;
	/** Who the screen acts for: bound by the host, never by a request. */
	context: () => WorldClaimsContext;
	/** Advances an accepted forget after the accepting transaction committed (World's lifecycle). */
	resumeForget: (forgetId: string) => Promise<unknown>;
	/** The person's latest statements of the conversation, newest first: the reason of a change. */
	reasonMessages: () => ReadonlyArray<{ id: string; text: string }>;
	/** Told (never the person) when advancing an accepted forget failed; it stays pending and is resumed. */
	onForgetAdvanceFailed?: (error: unknown) => void;
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
	// A relation changes by a new relation, not by a typed value.
	correctable: row.claim.content.kind === "value",
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
});

const preview = (text: string) =>
	text.length > 40 ? `${text.slice(0, 40)}…` : text;
const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** What the World adapter offers, without the domain (bundle checks, evaluation). */
export const describeWorldAdapter = () => ({
	owner: "world",
	operations: new Map(
		(
			[
				["world.correct", "schema:world-claim-correct@1"],
				["world.retract", "schema:world-claim-retract@1"],
				["world.forget", "schema:world-claim-forget@1"],
			] as const
		).map(([name, inputSchemaRef]) => [
			name,
			{ inputSchemaRef, effect: "write" as const },
		]),
	),
	queries: new Set([STATUS, CLAIMS, FORGETS, REASONS]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:world@1",
});

/** The value a correction states, typed by its kind; a wrong form is an input error. */
function correctedValue(input: z.infer<typeof correct>) {
	if (input.valueKind === "string")
		return { kind: "string" as const, value: input.value };
	if (input.valueKind === "boolean") {
		if (input.value !== "true" && input.value !== "false")
			throw new Error("invalid_input");
		return { kind: "boolean" as const, value: input.value === "true" };
	}
	const value = Number(input.value);
	if (!input.value.trim() || !Number.isFinite(value))
		throw new Error("invalid_input");
	return { kind: "number" as const, value, unit: (input.unit ?? "").trim() };
}

/**
 * The typed World adapter: status, the claim list and the forget list, and the explicit
 * correction, retraction and forget of the owner. Changes are World's own transaction
 * operations, so the revision the person saw, the reason statement and the Scope gate stay in
 * the domain. A forget is only accepted here (its intake is durable with the action); it then
 * advances after the commit and the receipt states `accepted`, never `complete`, until World's
 * ledger says so. The adapter is unavailable while World is OFF (no ports).
 */
export function createWorldAdapter(
	lookup: WorldAdapterPortsLookup,
): DomainAdapter {
	/** Forgets accepted in transactions that have not committed yet. */
	const accepted = new Set<string>();
	const need = (): WorldAdapterPorts => {
		const ports = lookup();
		if (!ports) throw new Error("capability_unavailable");
		return ports;
	};
	const failed = (failure: ClaimFailure): never => {
		throw new Error(failure.code);
	};
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
		claim: string,
		digested: Record<string, unknown> = receipt,
	): AdapterResult {
		return {
			receipt,
			receiptRef: {
				owner: "world",
				operationId: requestId,
				digest: sha256(digested),
			},
			resultRefs: [
				{
					owner: "world",
					kind: "claim",
					id: claim,
					schemaRef: "domain:world.claim@1",
				},
			],
			replay: false,
		};
	}
	/** The receipt of an accepted forget: what it is is fixed, how far it got is read fresh. */
	function forgetReceipt(
		requestId: string,
		forgetId: string,
		view: ForgetView,
	) {
		return {
			receipt: {
				version: 1,
				kind: "claim-forget",
				forgetId,
				status: "accepted",
				display: view.display,
				// Only World's ledger can say a forget is complete.
				completed: view.display === "complete",
			},
			identity: { version: 1, kind: "claim-forget", forgetId, requestId },
		};
	}
	function invoke(tx: Database, name: string, raw: unknown, requestId: string) {
		const ports = need();
		const ctx = ports.context();
		if (name === "world.correct") {
			const input = correct.safeParse(raw);
			if (!input.success) throw new Error("invalid_input");
			const value = correctedValue(input.data);
			const result = ports.claims.correctInTransaction(tx, ctx, {
				requestId,
				expectedRevision: input.data.expectedRevision,
				target: { claimId: input.data.claimId },
				reasonMessageId: input.data.reasonMessageId,
				value,
			});
			if (result.status !== "ok") return failed(result);
			if (result.value.status !== "applied")
				throw new Error("invalid_world_request");
			return done(
				{
					version: 1,
					kind: "claim-corrected",
					claimId: result.value.claimId,
					status: "applied",
				},
				requestId,
				result.value.claimId,
			);
		}
		if (name === "world.retract") {
			const input = retract.safeParse(raw);
			if (!input.success) throw new Error("invalid_input");
			const result = ports.claims.retractInTransaction(tx, ctx, {
				requestId,
				expectedRevision: input.data.expectedRevision,
				target: { claimId: input.data.claimId },
				reasonMessageId: input.data.reasonMessageId,
			});
			if (result.status !== "ok") return failed(result);
			if (result.value.status !== "applied")
				throw new Error("invalid_world_request");
			return done(
				{
					version: 1,
					kind: "claim-retracted",
					claimId: result.value.claimId,
					status: "applied",
				},
				requestId,
				result.value.claimId,
			);
		}
		if (name === "world.forget") {
			const input = forget.safeParse(raw);
			if (!input.success) throw new Error("invalid_input");
			const result = ports.claims.forgetInTransaction(tx, ctx, {
				requestId,
				expectedRevision: input.data.expectedRevision,
				target: { claimId: input.data.claimId },
			});
			if (result.status !== "ok") return failed(result);
			if (result.value.status !== "accepted")
				throw new Error("invalid_world_request");
			const view = result.value.forget;
			accepted.add(view.forgetId);
			const { receipt, identity } = forgetReceipt(
				requestId,
				view.forgetId,
				view,
			);
			return done(receipt, requestId, input.data.claimId, identity);
		}
		throw new Error("capability_unavailable");
	}
	return {
		ref: WORLD_ADAPTER_REF,
		describe: describeWorldAdapter,
		availableInTransaction: () => lookup() !== undefined,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request) {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			return invoke(
				tx,
				request.operationName,
				request.input,
				request.requestId,
			);
		},
		// A forget goes on after it was accepted: its receipt is read with how far it got now.
		readInTransaction(tx, operationId) {
			const ports = lookup();
			if (!ports) return null;
			const view = ports.claims.forgetStatusInTransaction(
				tx,
				ports.context(),
				operationId,
			);
			if (!view) return null;
			const { receipt, identity } = forgetReceipt(
				operationId,
				view.forgetId,
				view,
			);
			return {
				receipt,
				receiptRef: {
					owner: "world",
					operationId,
					digest: sha256(identity),
				},
				resultRefs: [],
				replay: false,
			};
		},
		sourceInTransaction(_tx, query) {
			const ports = lookup();
			if (!ports) return null;
			const ctx = ports.context();
			switch (query) {
				case STATUS: {
					const status = ports.claims.status(ctx);
					const list = ports.claims.list(ctx);
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
									// Absence from the list is not "no such claim" when a read budget stopped it.
									listComplete:
										list.status === "ok" ? list.value.complete : undefined,
									stopped:
										list.status === "ok" ? list.value.stopped : undefined,
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
										items: list.value.items.map(claimRow),
									}
								: { items: [], unavailable: list.code },
					};
				}
				case FORGETS: {
					const forgets = ports.claims.forgets(ctx);
					return {
						revision: 0,
						data:
							forgets.status === "ok"
								? { items: forgets.value.forgets.map(forgetRow) }
								: { items: [], unavailable: forgets.code },
					};
				}
				case REASONS:
					return {
						revision: 0,
						data: {
							options: ports
								.reasonMessages()
								.slice(0, REASON_CHOICES)
								.map((m) => ({ value: m.id, label: preview(m.text) })),
						},
					};
				default:
					return null;
			}
		},
		targetInput: () => ({}),
		afterCommit() {
			const ports = lookup();
			const ids = [...accepted];
			accepted.clear();
			for (const forgetId of ids)
				void ports?.resumeForget(forgetId).catch((error: unknown) => {
					ports.onForgetAdvanceFailed?.(error);
				});
		},
	};
}
