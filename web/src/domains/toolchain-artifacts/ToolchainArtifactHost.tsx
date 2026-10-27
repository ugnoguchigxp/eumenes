import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import type { Snapshot } from "@eumenes/artifact-ui/contracts";
import { Button } from "@eumenes/design-system";
import { GooglePhotoPicker } from "../../media/GooglePhotoPicker";
import { LightAvatarMotionLab } from "../../components/domains/conversation/LightAvatarMotionLab";
import { model3dApiFor } from "../model3d/api";
import { Model3dViewer } from "../model3d/Model3dViewer";
import { Model3dThumbnail } from "../model3d/Model3dThumbnail";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { useActionWiring } from "./action-wiring";
import { useCollectionActions } from "./collection-actions";
import { useInputBridge, withEditingState } from "./input-bridge";
import { useCollections } from "./use-collections";
import { useDraftActions } from "./draft-actions";
import {
	documentsOf,
	useDocumentFields,
	useDraftViews,
} from "./document-hooks";
import { dirtyEntries } from "./documents";
import { toolchainArtifactsQuery } from "./launcher";
import { useAnswer, useOpenQuestion } from "./questions";
import { useScreenDispatch } from "./screen-dispatch";
import { SecretNotice, useSecretNotice } from "./secret-notice";
import type {
	AdapterState,
	WebAdapterRegistry,
	WebArtifactAdapter,
} from "./registry";

export { findActionBinding } from "./screen-dispatch";

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

/** Views drawn by this host; the 3D lab and the model viewer load their renderers when shown. */
function hostViewsFor(client: EumenesClient): ArtifactRuntime["hostViews"] {
	return {
		"image-picker-photos": ({ onSelect }) => (
			<GooglePhotoPicker client={client} onSelect={onSelect} />
		),
		"avatar-motion-lab": () => <LightAvatarMotionLab />,
		"model3d-viewer": ({ assetId }) => (
			<Model3dViewer assetId={assetId} api={model3dApiFor(client)} />
		),
		"model3d-thumbnail": ({ assetId }) => (
			<Model3dThumbnail assetId={assetId} api={model3dApiFor(client)} />
		),
	};
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
	// The notice bar belongs to the action wiring, which is built after the adapter.
	const noticeRef = useRef<(message: string) => void>(noop);
	const notify = useCallback(
		(message: string) => noticeRef.current(message),
		[],
	);
	const own: AdapterState = adapter.useArtifact({
		conversationId,
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
		notify,
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
			await reload();
		},
		refresh: () => {
			own.refresh();
			reload();
		},
	};
	const withLists = useMemo<Snapshot>(
		() =>
			withEditingState(
				{ ...own.snapshot, ...collections.resources },
				artifact,
				drafts,
			),
		[own.snapshot, collections.resources, artifact, drafts],
	);
	const { setEditing, readSecret } = useInputBridge(
		client.identity,
		artifactId,
		artifact,
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
	useEffect(() => {
		noticeRef.current = setNotice;
	}, [setNotice]);
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

	const dispatch = useScreenDispatch({
		client,
		artifact,
		documents,
		getLatest,
		collectionEvent,
		draftAction,
		applyDraft,
		answer,
		describe,
		dispatcherRef,
		reveal,
		onNavigate,
	});

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
	const hostViews = useMemo(() => hostViewsFor(client), [client]);
	const runtime = useMemo<ArtifactRuntime>(
		() => ({
			snapshot,
			setEditing,
			readSecret,
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
			setEditing,
			readSecret,
			dispatch,
			settledEpoch,
			client,
			hostViews,
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
