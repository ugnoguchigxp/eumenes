import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import { Button } from "@eumenes/design-system";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ActionBindingV1,
	ArtifactDefinitionV1,
} from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";
import {
	createActionDispatcher,
	type ActionDispatcher,
	type ActionOutcome,
} from "./dispatcher";
import { receiptOf, rejectionMessage, unsettledMessage } from "./messages";
import { createOutbox } from "./outbox";
import type {
	AdapterState,
	AnswerInput,
	OpenQuestion,
	WebAdapterRegistry,
	WebArtifactAdapter,
} from "./registry";
import "./ToolchainArtifactHost.css";

export type ToolchainArtifactHostProps = {
	client: EumenesClient;
	adapters: WebAdapterRegistry;
	artifactRevisionId: string;
	/** The tab's instance id (opaque to the backend). */
	artifactId: string;
	/** A presentation variant of the registered artifact; undefined is its default. */
	variantId?: string;
	/** The saved item the screen shows, chosen inside the screen. */
	targetRef?: string;
	visible?: boolean;
	onTargetChange?: (ref: string | undefined) => void;
	conversationId?: string;
};

const noop = () => {};

/** The event's binding: same event and source first, else the only binding of that event. */
export function findActionBinding(
	bindings: readonly ActionBindingV1[],
	event: Pick<ArtifactEvent, "action" | "source">,
): ActionBindingV1 | undefined {
	const exact = bindings.find(
		(b) => b.eventAction === event.action && b.source === event.source,
	);
	if (exact) return exact;
	const same = bindings.filter((b) => b.eventAction === event.action);
	return same.length === 1 ? same[0] : undefined;
}

function Message({ children, alert }: { children: string; alert?: boolean }) {
	return alert ? (
		<p role="alert" className="toolchain-artifact-message">
			{children}
		</p>
	) : (
		<output className="toolchain-artifact-message">{children}</output>
	);
}

/**
 * The one generic screen for a registered artifact: it reads the artifact revision, picks the
 * variant, lets the domain's Web adapter provide source data, and sends every write action
 * through the outbox to `POST /api/toolchain-actions`.
 */
export function ToolchainArtifactHost(props: ToolchainArtifactHostProps) {
	const { client, artifactRevisionId } = props;
	const detail = useQuery({
		queryKey: [
			queryRoots.toolchainArtifacts,
			client.identity,
			"artifact",
			artifactRevisionId,
		],
		queryFn: ({ signal }) =>
			client.toolchainArtifact(artifactRevisionId, signal),
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (detail.isPending) return <Message>画面を読み込んでいます</Message>;
	if (detail.isError)
		return (
			<Message alert>
				画面の定義を取得できません。接続を確認してください。
			</Message>
		);
	const adapterRef = detail.data.artifact.sourceBindings[0]?.adapterRef;
	const adapter = adapterRef ? props.adapters.get(adapterRef) : undefined;
	if (
		!adapter ||
		detail.data.artifact.sourceBindings.some((s) => s.adapterRef !== adapterRef)
	)
		return <Message alert>この画面はこのアプリでは表示できません。</Message>;
	return (
		<AdapterScreen
			key={artifactRevisionId}
			{...props}
			adapter={adapter}
			artifact={detail.data.artifact}
			scopeRef={detail.data.scopeRef}
		/>
	);
}

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

function AdapterScreen({
	client,
	adapter,
	artifact,
	scopeRef,
	artifactRevisionId,
	artifactId,
	variantId,
	targetRef,
	visible = true,
	onTargetChange,
	conversationId = "main",
}: ToolchainArtifactHostProps & {
	adapter: WebArtifactAdapter;
	artifact: ArtifactDefinitionV1;
	scopeRef: string;
}) {
	const cache = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);
	const [settledEpoch, setSettledEpoch] = useState(0);
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
	const state: AdapterState = adapter.useArtifact({
		client,
		artifact,
		artifactRevisionId,
		targetRef,
		setTargetRef: onTargetChange ?? noop,
		visible,
	});
	const snapshot = useMemo<Snapshot>(
		() =>
			questionSource && question
				? {
						...state.snapshot,
						[questionSource]: {
							kind: "question",
							revision: question.revision,
							status: "open",
							question: {
								prompt: question.prompt,
								...(question.choices?.length
									? { options: question.choices.map((c) => c.label) }
									: {}),
							},
						},
					}
				: state.snapshot,
		[state.snapshot, questionSource, question],
	);
	const latest = useRef({ state, snapshot, question });
	useEffect(() => {
		latest.current = { state, snapshot, question };
	});

	const describe = useCallback(
		(
			code: string | undefined,
			fieldErrors: ReadonlyArray<{ field: string; message: string }>,
		) =>
			rejectionMessage(code, fieldErrors, (c, f) =>
				latest.current.state.describeRejection?.(c, f),
			),
		[],
	);

	const outbox = useMemo(
		() => createOutbox(client.identity),
		[client.identity],
	);
	const dispatcherRef = useRef<ActionDispatcher | null>(null);
	useEffect(() => {
		const dispatcher = createActionDispatcher({
			client,
			outbox,
			artifactId,
			artifactRevisionId,
			scopeRef,
			onSettled(event, outcome) {
				setSettledEpoch((n) => n + 1);
				const binding = artifact.actionBindings.find(
					(a) => a.actionId === event.actionId,
				);
				if (outcome.kind === "accepted") {
					if (binding && outcome.result)
						latest.current.state.settled(binding, outcome.result, {
							sent: performance.now(),
							sentAt: Date.now(),
						});
					setNotice("前回の操作の結果を確認し、画面に反映しました。");
				} else if (outcome.kind === "rejected") {
					latest.current.state.refresh();
					setNotice(
						`前回の操作は完了しませんでした。${describe(outcome.code, outcome.fieldErrors)}`,
					);
				}
			},
			onDiscarded() {
				setNotice(
					"以前の操作を照合できていません。画面の状態を確認してから、必要なら操作し直してください。",
				);
			},
			onUnknown() {
				setNotice("結果を確認中の操作があります。");
			},
		});
		dispatcherRef.current = dispatcher;
		void dispatcher.start();
		const retry = () => void dispatcher.reconcileAll();
		window.addEventListener("online", retry);
		window.addEventListener("focus", retry);
		return () => {
			window.removeEventListener("online", retry);
			window.removeEventListener("focus", retry);
			dispatcher.stop();
			dispatcherRef.current = null;
		};
	}, [
		client,
		outbox,
		artifactId,
		artifactRevisionId,
		scopeRef,
		artifact,
		describe,
	]);

	const answerIds = useRef(new Map<string, string>());
	const answer = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const { state: s, question: q } = latest.current;
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
		[client, cache],
	);

	const dispatch = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const { state: s, snapshot: shown } = latest.current;
			const binding = findActionBinding(artifact.actionBindings, event);
			if (!binding)
				return { status: "rejected", message: "この操作は利用できません" };
			const current = shown[event.source];
			if (current && current.revision !== event.revision)
				return {
					status: "conflict",
					message: "状態が変わりました。もう一度お試しください。",
				};
			if (binding.effect === "local") return s.local(binding, event);
			if (binding.answer) return answer(event);
			const timing = { sent: performance.now(), sentAt: Date.now() };
			const dispatcher = dispatcherRef.current;
			if (!dispatcher)
				return { status: "rejected", message: "画面を準備しています。" };
			const outcome: ActionOutcome = await dispatcher.send({
				actionId: binding.actionId,
				source: binding.source,
				sourceRevision: shown[binding.source]?.revision ?? event.revision,
				targetRef: s.targetOf(binding.source),
				input: event.values,
			});
			if (outcome.kind === "accepted" && outcome.result)
				s.settled(binding, outcome.result, timing);
			if (outcome.kind === "rejected" && outcome.conflict) s.refresh();
			return receiptOf(outcome, describe);
		},
		[artifact, answer, describe],
	);

	const variant = artifact.variants.find(
		(v) => v.id === (variantId ?? artifact.defaultVariant),
	);
	const definition = useMemo(
		() =>
			variant
				? JSON.stringify(
						question && variant.questionDefinition
							? variant.questionDefinition
							: variant.definition,
					)
				: null,
		[variant, question],
	);
	const runtime = useMemo<ArtifactRuntime>(
		() => ({ snapshot, dispatch, settledEpoch }),
		[snapshot, dispatch, settledEpoch],
	);
	return (
		<div className="toolchain-artifact">
			{notice && (
				<output className="toolchain-artifact-notice" aria-live="polite">
					<span>{notice}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setNotice(null)}
					>
						お知らせを閉じる
					</Button>
				</output>
			)}
			{!variant || !definition ? (
				<Message alert>指定された表示バリアントが見つかりません。</Message>
			) : state.phase.kind === "loading" ? (
				<Message>読み込んでいます</Message>
			) : state.phase.kind === "error" ? (
				<Message alert>{state.phase.message}</Message>
			) : state.phase.kind === "blocked" ? (
				<Message>{state.phase.message}</Message>
			) : (
				<ArtifactRenderer definition={definition} runtime={runtime} />
			)}
		</div>
	);
}
