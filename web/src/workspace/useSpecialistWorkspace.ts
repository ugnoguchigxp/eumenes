import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	Addressee,
	SpecialistSession,
	Viewing,
} from "../../../api/domains/dialogue/contracts";
import type { EumenesClient } from "../../../client";
import { ApiError } from "../../../client/transport";
import { useArtifactWorkspace } from "../domains/artifact";
import {
	useCancel,
	useSpecialistCommand,
	useSpecialistSession,
} from "../domains/dialogue";
import { describeError } from "../errorMessages";
import { UI_STUDIO_ARTIFACT_ID } from "../domains/ui-compositions/toolchain-adapter";
import {
	artifactIdOf,
	useToolchainArtifacts,
} from "../domains/toolchain-artifacts";
import type {
	BridgeResult,
	SpecialistBridge,
} from "../domains/toolchain-artifacts/specialist-bridge";

const conversationId = "main";
const noticeMs = 6_000;

const ok: BridgeResult = { ok: true };
const failure = (message: string): BridgeResult => ({ ok: false, message });
function describeCommandError(error: unknown) {
	if (error instanceof ApiError) {
		if (error.message === "work_busy")
			return "専門担当の作業中です。停止してから操作してください。";
		if (error.message === "work_unsaved")
			return "未保存の変更があります。保存するか破棄してください。";
		if (error.status === 409 || error.message === "revision_conflict")
			return "状態が変わりました。画面を確認してもう一度お試しください。";
	}
	return describeError(error);
}

type Workspace = ReturnType<typeof useArtifactWorkspace>;
type ToolchainLauncher = ReturnType<typeof useToolchainArtifacts>;

/**
 * The conversation's specialist session on the workspace: who the user is talking to, the
 * switch notice, opening and closing the specialist's artifact (with the screens that belong to
 * it), and the commands a screen can send.
 */
export function useSpecialistWorkspace({
	client,
	artifacts,
	toolchain,
	runSignature,
}: {
	client: EumenesClient;
	artifacts: Workspace;
	toolchain: ToolchainLauncher;
	/** Changes whenever a run starts or ends, so the session is read again promptly. */
	runSignature: string;
}) {
	const query = useSpecialistSession(client, conversationId);
	const refetchSession = query.refetch;
	const session: SpecialistSession | null = query.data ?? null;
	const command = useSpecialistCommand(client, conversationId);
	const cancel = useCancel(client, conversationId);
	const sessionRef = useRef(session);
	const tabsRef = useRef(artifacts.tabs);
	const activeRef = useRef(artifacts.active);
	useEffect(() => {
		sessionRef.current = session;
		tabsRef.current = artifacts.tabs;
		activeRef.current = artifacts.active;
	});
	const { close, setTarget } = artifacts;
	const { openEntry } = toolchain;

	// A run starting or ending can change the session; read it again instead of waiting.
	useEffect(() => {
		if (runSignature) void refetchSession();
	}, [runSignature, refetchSession]);

	const tabOf = useCallback(
		(artifactRevisionId: string) =>
			tabsRef.current.find(
				(tab) =>
					tab.kind === "toolchain" &&
					tab.artifactRevisionId === artifactRevisionId,
			),
		[],
	);
	// The screen's copy may lag by a poll: decide on what the server holds now.
	const freshSession = useCallback(async () => {
		const read = await refetchSession();
		return read.isError ? sessionRef.current : (read.data ?? null);
	}, [refetchSession]);

	// The specialist's artifact opens when its session becomes active and shows the draft.
	const announced = useRef<{ id: string; active: boolean } | null>(null);
	const loaded = useRef(false);
	const [notice, setNotice] = useState<string | null>(null);
	const sessionId = session?.id ?? null;
	const sessionActive = session?.state === "active";
	const sessionTitle = session?.title ?? "";
	const sessionArtifact = session?.artifactRevisionId ?? "";
	useEffect(() => {
		if (!query.isSuccess) return;
		const before = announced.current;
		const wasActive = !!before?.active;
		announced.current = sessionId
			? { id: sessionId, active: sessionActive }
			: null;
		const fresh =
			sessionActive && (!before || !before.active || before.id !== sessionId);
		if (fresh) {
			const tab = tabOf(sessionArtifact);
			if (tab) setTarget(tab.id, undefined);
			else
				openEntry(
					toolchain.entries.find(
						(entry) => entry.artifactRevisionId === sessionArtifact,
					) ?? {
						artifactRevisionId: sessionArtifact,
						title: sessionTitle,
						launcher: undefined,
					},
					undefined,
					false,
				);
		}
		// The first read is the baseline: only a change after it is announced.
		if (loaded.current) {
			if (fresh) setNotice(`サブエージェントに切り替えます（${sessionTitle}）`);
			else if (wasActive && !sessionActive) setNotice("通常の会話に戻りました");
		}
		loaded.current = true;
	}, [
		query.isSuccess,
		sessionId,
		sessionActive,
		sessionTitle,
		sessionArtifact,
		setTarget,
		openEntry,
		toolchain.entries,
		tabOf,
	]);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), noticeMs);
		return () => clearTimeout(timer);
	}, [notice]);

	const run = useCallback(
		async (
			kind: Parameters<typeof command.mutateAsync>[0]["kind"],
		): Promise<BridgeResult> => {
			const current = await freshSession();
			if (!current) return failure("専門担当との会話は終了しています。");
			try {
				await command.mutateAsync({ session: current, kind });
				return ok;
			} catch (error) {
				return failure(describeCommandError(error));
			}
		},
		[command, freshSession],
	);

	// Unsaved work is never closed silently: the user chooses to discard or keep editing.
	const [asking, setConfirming] = useState<{
		tabId: string;
		sessionId: string;
		busy: boolean;
		error: string | null;
	} | null>(null);
	const requestClose = useCallback(
		async (artifactRevisionId: string): Promise<BridgeResult> => {
			const tab = tabOf(artifactRevisionId);
			if (!tab) return ok;
			const current = await freshSession();
			if (current?.artifactRevisionId !== artifactRevisionId) {
				close(tab.id);
				return ok;
			}
			if (current.dirty) {
				setConfirming({
					tabId: tab.id,
					sessionId: current.id,
					busy: false,
					error: null,
				});
				return ok;
			}
			try {
				await command.mutateAsync({ session: current, kind: "close" });
			} catch (error) {
				// The screen may not know yet about a change the server holds.
				if (error instanceof ApiError && error.message === "work_unsaved") {
					void refetchSession();
					setConfirming({
						tabId: tab.id,
						sessionId: current.id,
						busy: false,
						error: null,
					});
					return ok;
				}
				return failure(describeCommandError(error));
			}
			close(tab.id);
			return ok;
		},
		[command, close, refetchSession, freshSession, tabOf],
	);
	const closeTab = useCallback(
		(tabId: string) => {
			const tab = tabsRef.current.find((t) => t.id === tabId);
			// The tab's close shares the screen's close flow (bridge.requestClose).
			if (tab?.kind === "toolchain")
				void requestClose(tab.artifactRevisionId).then((result) => {
					if (!result.ok) setNotice(result.message);
				});
			else close(tabId);
		},
		[close, requestClose],
	);
	// The session ended elsewhere while asking: nothing is left to discard.
	const confirming = asking && asking.sessionId === session?.id ? asking : null;
	const discardAndClose = useCallback(async () => {
		const target = confirming;
		if (!target) return;
		setConfirming({ ...target, busy: true, error: null });
		const result = await run("discard");
		if (result.ok) {
			setConfirming(null);
			close(target.tabId);
		} else setConfirming({ ...target, busy: false, error: result.message });
	}, [confirming, run, close]);

	const bridge = useMemo<SpecialistBridge>(
		() => ({
			session,
			command: (kind) => run(kind),
			stopRun: async () => {
				const runId = sessionRef.current?.activeRunId;
				if (!runId) return failure("停止できる処理はありません。");
				try {
					await cancel.mutateAsync(runId);
					return ok;
				} catch (error) {
					return failure(describeCommandError(error));
				}
			},
			requestClose,
			closeSession: () => run("close"),
		}),
		[session, run, cancel, requestClose],
	);

	/** The saved work the focused studio tab shows; sent with the next message. */
	const viewing = useCallback((): Viewing | undefined => {
		const tab = activeRef.current;
		return tab?.kind === "toolchain" &&
			tab.targetRef &&
			artifactIdOf(tab.artifactRevisionId) === UI_STUDIO_ARTIFACT_ID
			? {
					artifactRevisionId: tab.artifactRevisionId,
					targetRef: tab.targetRef,
				}
			: undefined;
	}, []);

	/** Who the user sees as the addressee now; sent with a message so a switch is not missed. */
	const addresseeNow = useCallback((): Addressee => {
		const current = sessionRef.current;
		return current?.state === "active"
			? { sessionId: current.id, epoch: current.epoch }
			: { sessionId: null, epoch: null };
	}, []);

	return {
		session,
		refetchSession,
		addresseeNow,
		addressee:
			session?.state === "active"
				? { kind: "specialist" as const, label: session.title }
				: {
						kind: "normal" as const,
						label: "通常",
						suspended: session?.state === "suspended" ? session.title : null,
					},
		notice,
		dismissNotice: () => setNotice(null),
		bridge,
		closeTab,
		viewing,
		confirm: confirming
			? {
					busy: confirming.busy,
					error: confirming.error,
					discard: discardAndClose,
					keep: () => setConfirming(null),
				}
			: null,
	};
}
export type SpecialistWorkspace = ReturnType<typeof useSpecialistWorkspace>;
