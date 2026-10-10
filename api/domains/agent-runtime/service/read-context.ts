import { z } from "zod";
import {
	bytes,
	hash,
	zSchema,
	validators,
	researchInput,
	type Prepared,
	type SchemaKey,
} from "../../capabilities";
import type { Source } from "../../tool-runtime";
import {
	needsSchema,
	reportV2Schema,
	workerSchema,
	type Task,
} from "../contracts";
import { evidenceObservation } from "./evidence-excerpts";
import { isHistory, modelLimit } from "./exploration";
import type { Messages } from "../../inference/contracts";
import { nextSavedRead, correctedRead, bodyReadReferences } from "./read-next";
import { readSchema } from "./read-schema";
import { requestQuotes } from "./request-quotes";
type ReadTool = {
	executionRef: string;
	tool: { id: string; schemaKey?: SchemaKey };
};
export function readContext(
	task: Task,
	prepared: Prepared,
	tools: ReadTool[],
	sources: Source[],
	operations: unknown,
	policy: string,
	hint?: { toolId: string; arguments: unknown } | null,
) {
	const required = new Set([
		prepared.package.profileRevisionId,
		...(prepared.package.requiredSkillRevisionIds ?? []),
	]);
	const sections = prepared.dependencies
		.filter(
			(d) =>
				required.has(d.revisionId) && ["profile", "skill"].includes(d.kind),
		)
		.map((d) => ({ revisionId: d.revisionId, hash: d.hash, body: d.body }));
	if (
		sections.length !== required.size ||
		sections.some((s) => !s.body?.trim())
	)
		throw new Error("required_context_missing");
	const input = researchInput.parse(prepared.input);
	const hinted = hint ? tools.find((t) => t.tool.id === hint.toolId) : null;
	const validHint = hinted?.tool.schemaKey
		? validators[hinted.tool.schemaKey].safeParse(hint?.arguments)
		: null;
	const readUrls = [
		...new Set([
			...(input.urls ?? []),
			...sources.flatMap((s) => (s.url ? [s.url] : [])),
			...(hinted?.tool.id === "web.read" && validHint?.success
				? [(validHint.data as { url: string }).url]
				: []),
		]),
	];
	const fixedContracts = tools.map((t) => ({
		executionRef: t.tool.id,
		id: t.tool.id,
		inputSchema: t.tool.schemaKey
			? {
					...zSchema(t.tool.schemaKey),
					...(t.tool.schemaKey === "readSaved"
						? { not: { required: ["cursor", "start"] } }
						: {}),
				}
			: null,
	}));
	const contracts = fixedContracts.filter(
		(t) => t.id !== "web.read" || readUrls.length,
	);
	if (bytes({ sections, contracts: fixedContracts }) > 16384)
		throw new Error("required_context_overflow");
	const first = !task.exploration_json;
	const quotes = requestQuotes(input.question);
	const quotedNeeds = needsSchema.element
		.extend({
			requestQuote: z.enum(quotes as [string, ...string[]]),
		})
		.array()
		.min(1)
		.max(8);
	const needs = first ? quotedNeeds : quotedNeeds.optional();
	const finish = workerSchema.options[1].extend({
		report: reportV2Schema,
		needs,
	});
	const schema = contracts.length
		? z.discriminatedUnion("action", [
				workerSchema.options[0].extend({
					needs,
					executionRef: z.enum(
						contracts.map((t) => t.id) as [string, ...string[]],
					),
				}),
				finish,
			])
		: finish;
	const operationList = (Array.isArray(operations) ? operations : []).map(
		(o) => ({
			tool: o.tool,
			state: o.state,
			errorCode: o.errorCode,
			arguments: o.arguments,
			operationFingerprint: o.operationFingerprint,
			failures: Array.isArray(o.failures)
				? o.failures
						.slice(0, 8)
						.map((f: { code: string }) => ({ code: f.code }))
				: [],
			notes: o.notes,
		}),
	);
	const operationMetadata = operationList.map(
		({ notes: _notes, ...metadata }) => metadata,
	);
	while (bytes(operationList) > 14000) {
		const index = operationList.findIndex((o) => o.notes && !o.notes.omitted);
		if (index < 0) break;
		operationList[index] = {
			...operationMetadata[index]!,
			notes: { omitted: true },
		};
	}
	const visible = [...sources];
	let observations = visible.map(evidenceObservation);
	while (
		bytes({ observations, operations: operationList }) > 20000 &&
		visible.length
	) {
		const repeated = visible.findIndex((s, i) =>
			visible.slice(i + 1).some((other) => other.sourceId === s.sourceId),
		);
		const snippet = visible.findIndex((s) => s.basis === "snippet");
		visible.splice(
			repeated >= 0
				? repeated
				: snippet >= 0
					? snippet
					: Math.floor(visible.length / 2),
			1,
		);
		observations = visible.map(evidenceObservation);
	}
	const history = isHistory(prepared);
	const now = new Date();
	const unread = history
		? null
		: sources.find(
				(s) =>
					s.basis === "snippet" &&
					!sources.some((p) => p.basis === "page" && p.url === s.url),
			);
	const corrected = correctedRead(operationList, visible);
	const savedRead =
		(corrected && tools.some((t) => t.tool.id === corrected.executionRef)
			? corrected
			: null) ??
		(tools.some((t) => t.tool.id === "web.read_saved")
			? nextSavedRead(operationList, visible)
			: null);
	const hintUnread =
		hinted?.tool.id !== "web.read" ||
		!sources.some(
			(s) =>
				s.basis === "page" &&
				s.url === (hint?.arguments as { url?: string })?.url,
		);
	const requested = input.urls?.find(
		(url) => !sources.some((s) => s.basis === "page" && s.url === url),
	);
	const nextUrl = unread?.url ?? requested;
	const nextInvocation =
		savedRead ??
		(validHint?.success && hintUnread
			? {
					action: "invoke",
					executionRef: hinted!.tool.id,
					arguments: validHint.data,
				}
			: nextUrl && tools.some((t) => t.tool.id === "web.read")
				? {
						action: "invoke",
						executionRef: "web.read",
						arguments: { url: nextUrl },
					}
				: null);
	const ids = operationList.map((o) => String(o.tool ?? ""));
	const usedLocal = ids.filter((id) =>
		/tool:(web\.find|web\.read_saved|history\.)/.test(id),
	).length;
	const external = ids.length - usedLocal;
	const data = {
		task: prepared.input,
		initialNeedsRequired: first,
		requestQuoteExample: quotes[0],
		requestQuoteOptions: quotes,
		now: now.toISOString(),
		timeZone: "Asia/Tokyo",
		currentDate: new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Tokyo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(now),
		budget: {
			canInvoke: contracts.length > 0,
			remainingMilliseconds: Math.max(0, (task.deadline ?? 0) - now.getTime()),
			toolCallsUsed: task.tool_calls,
			maxToolCalls: history ? 4 : 9,
			modelCallsUsed: task.model_calls,
			maxModelCalls: modelLimit(prepared),
			externalCallsUsed: external,
			maxExternalCalls: history ? 0 : 5,
			localCallsUsed: usedLocal,
			maxLocalCalls: 4,
			lookupCallsRemaining: history
				? 0
				: Math.max(
						0,
						2 - ids.filter((id) => id.startsWith("tool:web.lookup@")).length,
					),
			fetchCallsRemaining: history
				? 0
				: Math.max(
						0,
						3 -
							ids.filter((id) => /tool:web\.(read|forecast|quote)@/.test(id))
								.length,
					),
			localCallsRemaining: Math.max(0, 4 - usedLocal),
			finishReserved: true,
		},
		needs: task.exploration_json ? JSON.parse(task.exploration_json) : [],
		bodyReadReferences: bodyReadReferences(visible),
		observations,
		operations: operationList,
		explorationExample: [
			`提示済みの資料範囲を確認。外部操作${external}回、ローカル読取り${usedLocal}回。未提示範囲は未確認。`,
		],
		...(contracts.length
			? {}
			: {
					finishExample: {
						action: "finish",
						report: {
							version: 2,
							outcome: "failed",
							summary: "残り予算内で必要な確認を完了できませんでした。",
							claims: [],
							limitations: ["追加取得は許可されていません。"],
							exploration: [
								`外部操作${external}回、ローカル読取り${usedLocal}回。`,
							],
						},
						...(first
							? {
									needs: [
										{
											id: "n1",
											item: "依頼項目の確認",
											requestQuote: quotes[0],
											status: "missing",
										},
									],
								}
							: {}),
					},
				}),
		nextInvocation,
	};
	const messages: Messages = [
		{
			role: "system",
			content:
				policy +
				"\n" +
				sections.map((s) => s.body).join("\n") +
				"\n初回はinvokeでもfinishでもトップレベルのneeds配列が必須です。各要素は{id,item,requestQuote,status}で、statusはmissing/confirmed/mismatchです。requestQuoteはrequestQuoteOptionsの原文候補からそのまま選び、要約・言換えをしません。現在の依頼の原文を使い、必要項目の状態を更新します。\n" +
				"\n必要な範囲だけを読み、現在のobservationsに含まれるsourceId,viewId,excerptIdで引用します。quoteは入力しません。version:2の終了種別と探索範囲を返します。report.explorationは空配列にせず、確認した範囲を1項目以上記します。explorationExampleは現在の操作回数に基づく記載例です。追加操作がTOOLSになければfinishだけを使います。取得失敗・対象不一致・取得省略・矛盾を区別してlimitationsへ記します。\n" +
				"budget.canInvokeがfalseならaction:finishで終了します。finishExampleは失敗時の形の例です。必要項目を確認済みなら、終了種別をansweredまたはpartialにし、現在の提示根拠をclaimsへ入れて答えます。\n" +
				(history
					? "以前の発言はspeakerとcreatedAtを添え、Assistantの発言を現在の事実保証にしません。WebのURLや天気の観測はありません。"
					: "web.findは本文内の位置を見つけます。本文操作のsourceRefはbodyReadReferencesから対象資料の値をそのままコピーします。sourceId/viewIdは報告の引用に使います。根拠に使うにはweb.read_savedでmatchesのcursorの範囲を読みます。cursorを渡す場合startキーは省略します。nextInvocationは現在の許可toolと発行済み参照に合う呼出し例です。既にobservationsに含まれる範囲を重ねて読みません。必要項目が確認できればneedsをconfirmedに更新してfinishします。資料が目的と違えば未読候補や不足項目を含む再検索へ進みます。\n依頼項目が不足するという診断があれば別の候補を補います。") +
				"\nTOOLS=" +
				JSON.stringify(contracts) +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(
					readSchema(z.toJSONSchema(schema), contracts, visible, readUrls),
				),
		},
		{ role: "user", content: JSON.stringify(data) },
	];
	if (task.error_code)
		messages.push({
			role: "system",
			content:
				(task.error_code === "invalid_report"
					? "前回の報告は根拠または依頼項目が不十分です。"
					: "") +
				"前回の拒否/操作の失敗コード=" +
				task.error_code +
				"。同じ成功済み操作を繰り返さず、残予算で別操作または理由付きfinishを返します。",
		});
	if (bytes(messages) > 65536) throw new Error("required_context_overflow");
	return {
		messages,
		visible,
		manifestDigest: hash({
			sections,
			contracts: fixedContracts,
			grants: tools.map((t) => t.executionRef),
			renderVersion: 19,
		}),
	};
}
