import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import { Button } from "@eumenes/design-system";
import { LightAvatarMotionLab } from "../../components/domains/conversation/LightAvatarMotionLab";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
	ActionBindingV1,
	ArtifactDefinitionV1,
} from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { useActionWiring } from "./action-wiring";
import { useCollectionActions } from "./collection-actions";
import { useCollections } from "./use-collections";
import type { ActionOutcome } from "./dispatcher";
import { useDraftActions } from "./draft-actions";
import {
	documentsOf,
	useDocumentFields,
	useDraftViews,
} from "./document-hooks";
import { dirtyEntries } from "./documents";
import { toolchainArtifactsQuery } from "./launcher";
import { receiptOf } from "./messages";
import { navigationDestination } from "./navigation";
import { useAnswer, useOpenQuestion } from "./questions";
import { SecretNotice, useSecretNotice } from "./secret-notice";
import type {
	AdapterState,
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
	/** Opens the registered artifact with this id (a navigate binding); false when unknown. */
	onNavigate?: (artifactId: string) => Promise<boolean> | boolean;
	conversationId?: string;
};

const noop = () => {};

/** Views drawn by this host; the 3D lab loads its renderer only when shown. */
const hostViews: ArtifactRuntime["hostViews"] = {
	"avatar-motion-lab": () => <LightAvatarMotionLab />,
};
/**
 * The event's binding: the one registered for this event and source (a registration holds at
 * most one), else the only binding of that event. Panels with several actions register one
 * binding and name the action in the event's `id` value.
 */
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
	// The first source's adapter drives the screen; sources of other adapters are only read.
	if (!adapter)
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
	onNavigate,
	conversationId = "main",
}: ToolchainArtifactHostProps & {
	adapter: WebArtifactAdapter;
	artifact: ArtifactDefinitionV1;
	scopeRef: string;
}) {
	const { question, questionSource } = useOpenQuestion(
		client,
		artifact,
		artifactRevisionId,
		conversationId,
	);
	const catalogQuery = useQuery({
		...toolchainArtifactsQuery(client),
		// Navigation labels and a document's other screens come from the published list.
		enabled:
			documentsOf(artifact).length > 0 ||
			artifact.actionBindings.some((a) => a.effect === "navigate"),
	});
	const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
	const {
		fields: documentFields,
		documents,
		ready: documentFieldsReady,
	} = useDocumentFields(client, artifact, artifactRevisionId, catalog);
	const drafts = useDraftViews(client.identity, documents);
	const own: AdapterState = adapter.useArtifact({
		client,
		artifact,
		artifactRevisionId,
		targetRef,
		setTargetRef: onTargetChange ?? noop,
		visible,
		catalog,
		documentFields,
		documentFieldsReady,
		drafts,
	});
	// Documents whose shared draft has unapplied changes: row actions that need a clean one wait.
	const dirtyDocuments = new Set(
		documents.filter((ref) => {
			const view = drafts[ref];
			return (
				!!view &&
				(dirtyEntries(view, documentFields[ref] ?? [], own.documents?.[ref])
					.length > 0 ||
					view.structural.length > 0 ||
					view.secrets.length > 0)
			);
		}),
	);
	const collections = useCollections(
		client,
		artifact,
		artifactRevisionId,
		dirtyDocuments,
	);
	// A change to the saved data (a settled write, a conflict) reads the lists again too.
	const reload = collections.reload;
	const state: AdapterState = {
		...own,
		settled: async (...args) => {
			await own.settled(...args);
			reload();
		},
		refresh: () => {
			own.refresh();
			reload();
		},
	};
	const withLists = useMemo<Snapshot>(
		() => ({ ...own.snapshot, ...collections.resources }),
		[own.snapshot, collections.resources],
	);
	const snapshot = useMemo<Snapshot>(
		() =>
			questionSource && question
				? {
						...withLists,
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
				: withLists,
		[withLists, questionSource, question],
	);
	const latest = useRef({
		state,
		snapshot,
		question,
		documentFields,
	});
	useEffect(() => {
		latest.current = { state, snapshot, question, documentFields };
	});
	const getLatest = useCallback(() => latest.current, []);
	const { describe, dispatcherRef, notice, setNotice, settledEpoch } =
		useActionWiring({
			client,
			artifact,
			artifactId,
			artifactRevisionId,
			scopeRef,
			getLatest,
		});
	const answer = useAnswer(client, getLatest);
	const { token: secretToken, reveal, close: closeSecret } = useSecretNotice();
	const collectionEvent = useCollectionActions({
		client,
		artifact,
		collections,
		getLatest,
		dispatcherRef,
		describe,
		reveal,
	});
	const { draftAction, applyDraft } = useDraftActions({
		client,
		artifact,
		getLatest,
		dispatcherRef,
		describe,
	});

	const dispatch = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const { state: s, snapshot: shown } = latest.current;
			const collection = collectionEvent(event);
			if (collection) return collection;
			const binding = findActionBinding(artifact.actionBindings, event);
			if (!binding)
				return (
					s.sourceRead?.(event) ?? {
						status: "rejected",
						message: "この操作は利用できません",
					}
				);
			const current = shown[event.source];
			if (current && current.revision !== event.revision)
				return {
					status: "conflict",
					message: "状態が変わりました。もう一度お試しください。",
				};
			if (binding.effect === "local") return s.local(binding, event);
			if (binding.effect === "draft") return draftAction(binding, event);
			if (binding.effect === "navigate") {
				const destination = navigationDestination(binding, event.values);
				const opened = destination ? await onNavigate?.(destination) : false;
				return opened
					? { status: "accepted", message: "" }
					: { status: "rejected", message: "この画面は現在利用できません" };
			}
			if (binding.answer) return answer(event);
			if (binding.draftDocument) return applyDraft(binding, event);
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
			if (outcome.kind === "accepted" && outcome.result) {
				// A one-time value is shown before anything else can fail.
				reveal(outcome.result.receipt);
				s.settled(binding, outcome.result, timing, event.values);
			}
			if (outcome.kind === "rejected" && outcome.conflict) s.refresh();
			return receiptOf(outcome, describe);
		},
		[
			artifact,
			answer,
			describe,
			draftAction,
			applyDraft,
			onNavigate,
			dispatcherRef,
			collectionEvent,
			reveal,
		],
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
		() => ({
			snapshot,
			dispatch,
			refresh: state.refresh,
			settledEpoch,
			fetchMedia: (path: string) => client.toolchainMedia(path),
			hostViews,
			...(state.uploadFile ? { uploadFile: state.uploadFile } : {}),
			...(state.openTerminal ? { openTerminal: state.openTerminal } : {}),
		}),
		[
			snapshot,
			dispatch,
			settledEpoch,
			client,
			state.uploadFile,
			state.openTerminal,
			state.refresh,
		],
	);
	return (
		<div className="toolchain-artifact">
			<SecretNotice token={secretToken} onClose={closeSecret} />
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
