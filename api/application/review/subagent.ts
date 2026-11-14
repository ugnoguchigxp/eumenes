import type { Database } from "bun:sqlite";
import { z } from "zod";
import { hash, type Capabilities } from "../../domains/capabilities";
import {
	agentControl,
	agentSystemMessage,
	type InferencePort,
	type Messages,
} from "../../domains/inference";
import { parseLlmJson } from "../../infrastructure/llm-json";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { systemContext } from "../../infrastructure/system-context";

const OUTPUT_TOKENS = 4096;
const INPUT_BYTES = 128_000;
const text = (limit: number) => z.string().trim().min(1).max(limit);
const location = z.strictObject({
	evidenceId: text(120),
	pointer: z.string().max(1024),
});
const output = z.strictObject({
	findings: z
		.array(
			z.strictObject({
				title: text(200),
				problem: text(600),
				trigger: text(400),
				impact: text(600),
				severity: z.enum(["critical", "high", "medium", "low"]),
				confidence: z.enum(["high", "medium", "low"]),
				primary: location,
				evidence: z.array(location).max(5),
				conditionId: text(120).nullish(),
				minimalFix: text(600),
				verify: text(600),
			}),
		)
		.max(10),
	scopeChecks: z
		.array(
			z.strictObject({
				evidenceId: text(120),
				status: z.enum(["checked", "unverified"]),
				reason: text(600).nullable(),
			}),
		)
		.max(16),
	conditionChecks: z
		.array(
			z.strictObject({
				conditionId: text(120),
				status: z.enum(["satisfied", "violated", "unverified"]),
				reason: text(600),
				evidence: z.array(location).max(5),
			}),
		)
		.max(32),
	unverified: z.array(text(600)).max(10),
});
const outputSchema = z.toJSONSchema(output);

type Evidence = { id: string; document: unknown };
type ReviewConditions =
	| { state: "none" | "unavailable" }
	| { state: "available"; entries: readonly { id: string; text: string }[] };
type ReviewRequest = {
	skill: string;
	target: { id: string; version: string };
	originalRequest: string | null;
	request: string;
	evidence: readonly Evidence[];
	conditions: ReviewConditions;
	sourceMessageIds: readonly string[];
};

function containsPointer(document: unknown, pointer: string) {
	if (pointer === "") return document !== undefined;
	if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return false;
	let value = document;
	for (const token of pointer.slice(1).split("/")) {
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (
			!value ||
			typeof value !== "object" ||
			!Object.hasOwn(value, key) ||
			(Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))
		)
			return false;
		value = (value as Record<string, unknown>)[key];
	}
	return true;
}

function checkedResult(review: ReviewRequest, result: z.infer<typeof output>) {
	const documents = new Map(
		review.evidence.map(({ id, document }) => [id, document]),
	);
	const evidenceExists = ({ evidenceId, pointer }: z.infer<typeof location>) =>
		documents.has(evidenceId) &&
		containsPointer(documents.get(evidenceId), pointer);
	const expected =
		review.conditions.state === "available" ? review.conditions.entries : [];
	const conditionIds = new Set(expected.map(({ id }) => id));
	const scopeChecks = result.scopeChecks.filter(
		({ evidenceId, status, reason }) =>
			documents.has(evidenceId) && (status === "checked" || reason !== null),
	);
	const findings = result.findings.filter(
		({ primary, evidence, conditionId }) =>
			evidenceExists(primary) &&
			evidence.every(evidenceExists) &&
			(conditionId == null || conditionIds.has(conditionId)),
	);
	const conditionChecks = result.conditionChecks.filter(
		({ conditionId, status, evidence }) =>
			conditionIds.has(conditionId) &&
			evidence.every(evidenceExists) &&
			(status === "unverified" || evidence.length > 0),
	);
	const issues: string[] = [];
	if (
		findings.length !== result.findings.length ||
		conditionChecks.length !== result.conditionChecks.length ||
		scopeChecks.length !== result.scopeChecks.length
	)
		issues.push("review_reference_invalid");
	if (
		review.conditions.state === "unavailable" ||
		expected.some(
			({ id }) =>
				!conditionChecks.some(
					(check) => check.conditionId === id && check.status !== "unverified",
				),
		)
	)
		issues.push("conditions_unverified");
	if (
		result.unverified.length ||
		scopeChecks.some(({ status }) => status === "unverified") ||
		review.evidence.some(
			({ id }) => !scopeChecks.some((check) => check.evidenceId === id),
		)
	)
		issues.push("scope_unverified");
	return {
		findings: findings.map((finding) => ({
			...finding,
			conditionId: finding.conditionId ?? null,
		})),
		scopeChecks,
		conditionChecks,
		unverified: result.unverified,
		issues,
	};
}

export function createReviewSubagent(
	store: SqliteStore,
	inference: InferencePort,
	capabilities: Pick<Capabilities, "getDefinitionInTransaction">,
) {
	const {
		captureUserControlInTransaction,
		executeControl,
		acceptInTransaction,
	} = inference;
	if (
		!captureUserControlInTransaction ||
		!executeControl ||
		!acceptInTransaction
	)
		return undefined;
	return async (
		review: ReviewRequest,
		deadline: number,
		signal: AbortSignal,
		current: (db: Database) => boolean,
	) => {
		signal.throwIfAborted();
		const { skill: revisionId, sourceMessageIds, ...input } = review;
		const skill = store.read((db) =>
			capabilities.getDefinitionInTransaction(db, revisionId),
		);
		if (skill?.kind !== "skill" || !skill.body)
			throw new Error("review_skill_unavailable");
		const control = {
			...agentControl({
				profile: systemContext("agent-runtime.contexts.review.mission", {}),
				skills: [skill.body],
				rules: systemContext("agent-runtime.contexts.review.rules", {}),
				tools: [],
				outputSchema,
			}),
			larmReasoning: "off" as const,
		};
		const messages: Messages = [
			agentSystemMessage(control),
			{ role: "user", content: JSON.stringify(input) },
		];
		if (
			messages.reduce(
				(size, message) => size + Buffer.byteLength(message.content),
				0,
			) > INPUT_BYTES
		)
			throw new Error("review_input_too_large");
		const used = inference.countControlTokens?.(messages) ?? null;
		const window = inference.savedLlmContextWindow?.() ?? null;
		if (used !== null && window !== null && used + OUTPUT_TOKENS > window)
			throw new Error("context_window_exceeded");
		const isCurrent = (db: Database) =>
			!signal.aborted &&
			Date.now() < deadline &&
			current(db) &&
			capabilities.getDefinitionInTransaction(db, revisionId)?.hash ===
				skill.hash;
		const requestId = await store.write((db) => {
			if (!isCurrent(db)) throw new Error("review_stale");
			return captureUserControlInTransaction(db, {
				subject: `review:${crypto.randomUUID()}`,
				deadline: Math.min(deadline, Date.now() + 120_000),
				maxOutputTokens: OUTPUT_TOKENS,
				route: "subagent",
			});
		});
		let accepted = false;
		try {
			const receipt = await executeControl(
				requestId,
				messages,
				signal,
				control,
				{
					sessionRole: "auxiliary",
					refs: { messageIds: sourceMessageIds, itemIds: [] },
				},
			);
			const decoded = output.safeParse(parseLlmJson(receipt.value));
			if (!decoded.success) throw new Error("review_output_invalid");
			const checked = checkedResult(review, decoded.data);
			accepted = await store.write(
				(db) => isCurrent(db) && acceptInTransaction(db, receipt),
			);
			if (!accepted) throw new Error("review_stale");
			return {
				status: checked.issues.length
					? ("incomplete" as const)
					: ("completed" as const),
				summary: checked.issues.length
					? `評価に未確認の項目があります。確認できた指摘は${checked.findings.length}件です。`
					: `評価が完了しました。指摘は${checked.findings.length}件です。`,
				result: {
					target: {
						...review.target,
						digest: hash(JSON.stringify(review.evidence)),
					},
					skill: { revisionId, hash: skill.hash },
					...checked,
				},
			};
		} finally {
			if (!accepted)
				await store.write((db) =>
					inference.cancelRequestsInTransaction?.(db, [requestId]),
				);
		}
	};
}
