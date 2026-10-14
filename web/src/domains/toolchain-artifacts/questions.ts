import type { Receipt } from "@eumenes/artifact-ui/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";
import { unsettledMessage } from "./messages";
import type { AnswerInput, OpenQuestion } from "./registry";
import type { GetLatest } from "./screen-state";

function openQuestionOf(
	interactions: ReadonlyArray<{
		id: string;
		status: string;
		revision: number;
		artifactRevisionId: string | null;
		question: {
			questionId: string;
			prompt: string;
			inputSchemaRef: string;
			expiresAt: string;
			choices?: ReadonlyArray<{ ref: string; label: string }>;
		} | null;
	}>,
	artifactRevisionId: string,
): OpenQuestion | null {
	const found = interactions.find(
		(i) =>
			i.status === "waiting_input" &&
			i.artifactRevisionId === artifactRevisionId &&
			i.question &&
			Date.parse(i.question.expiresAt) > Date.now(),
	);
	if (!found?.question) return null;
	return {
		interactionId: found.id,
		questionId: found.question.questionId,
		revision: found.revision,
		prompt: found.question.prompt,
		inputSchemaRef: found.question.inputSchemaRef,
		choices: found.question.choices,
	};
}

function defaultAnswerInput(question: OpenQuestion, text: string): AnswerInput {
	if (question.inputSchemaRef === "builtin:answerText" && text)
		return { ok: true, value: { text } };
	return { ok: false, message: "この質問への回答を確認してください。" };
}

/** The open question of the artifact's chain, read from the interactions API. */
export function useOpenQuestion(
	client: EumenesClient,
	artifact: ArtifactDefinitionV1,
	artifactRevisionId: string,
	conversationId: string,
) {
	const questionSource = artifact.actionBindings.find((a) => a.answer)?.source;
	const interactions = useQuery({
		queryKey: [
			queryRoots.toolchainInteractions,
			client.identity,
			conversationId,
			"waiting_input",
		],
		queryFn: ({ signal }) =>
			client.toolchainInteractions(
				{ conversationId, status: "waiting_input" },
				signal,
			),
		enabled: !!questionSource,
	});
	const question = useMemo(
		() =>
			questionSource && interactions.data
				? openQuestionOf(interactions.data, artifactRevisionId)
				: null,
		[questionSource, interactions.data, artifactRevisionId],
	);
	return { question, questionSource };
}

/** Sends the answer of the open question through the interactions API (idempotent by id). */
export function useAnswer(client: EumenesClient, getLatest: GetLatest) {
	const cache = useQueryClient();
	const answerIds = useRef(new Map<string, string>());
	const answer = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const current = getLatest();
			const s = current.state;
			const q = current.question;
			if (!q)
				return {
					status: "rejected",
					message: "回答できる質問がありません。",
				};
			const text = String(event.values.answer ?? "").trim();
			const parsed = (s.answerInput ?? defaultAnswerInput)(q, text);
			if (!parsed.ok) return { status: "rejected", message: parsed.message };
			// A resend of the same answer keeps its id, so the server replays it once.
			const key = `${q.interactionId}:${q.questionId}:${JSON.stringify(parsed.value)}`;
			const eventId = answerIds.current.get(key) ?? crypto.randomUUID();
			answerIds.current.set(key, eventId);
			try {
				await client.answerToolchainInteraction(q.interactionId, {
					eventId,
					questionId: q.questionId,
					expectedRevision: q.revision,
					input: parsed.value,
				});
				answerIds.current.delete(key);
				void cache.invalidateQueries({
					queryKey: [queryRoots.toolchainInteractions],
				});
				void cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
				void cache.invalidateQueries({ queryKey: [queryRoots.conversation] });
				return { status: "accepted", message: "回答を送りました。" };
			} catch (error) {
				if (error instanceof ApiError && error.status === 409) {
					answerIds.current.delete(key);
					void cache.invalidateQueries({
						queryKey: [queryRoots.toolchainInteractions],
					});
					return {
						status: "conflict",
						message: "質問の状態が変わりました。最新の質問を読み込みます。",
					};
				}
				if (
					error instanceof ApiError &&
					error.status >= 400 &&
					error.status < 500 &&
					error.status !== 429
				) {
					answerIds.current.delete(key);
					void cache.invalidateQueries({
						queryKey: [queryRoots.toolchainInteractions],
					});
					return {
						status: "rejected",
						message:
							error.status === 410
								? "この質問は期限切れです。"
								: "回答を確認してください。",
					};
				}
				return { status: "indeterminate", message: unsettledMessage };
			}
		},
		[client, cache, getLatest],
	);

	return answer;
}
