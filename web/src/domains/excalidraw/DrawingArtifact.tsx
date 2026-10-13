import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArtifactRenderer, type ArtifactRuntime } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import type { DrawingSession } from "../../../../api/domains/excalidraw/contracts";
export const drawingDefinition = JSON.stringify({
	view: "drawing-workspace",
	source: "drawings",
	title: "図を描く・編集する",
});
export function DrawingArtifact({
	client,
	definition,
}: {
	client: EumenesClient;
	definition: string;
}) {
	const [session, setSession] = useState<DrawingSession | null>(null),
		[error, setError] = useState("");
	const active = useRef<string | null>(null),
		events = useRef(new Set<string>()),
		adoptedOperation = useRef<string | null>(null);
	const refs = useQuery({
		queryKey: ["drawings", client.identity],
		queryFn: ({ signal }) => client.drawingReferences("main", signal),
	});
	const status = useQuery({
		queryKey: ["drawing-session", session?.id],
		enabled: !!session,
		queryFn: ({ signal }) => client.drawingSession(session!.id, signal),
		refetchInterval: (q) => (q.state.data?.state === "starting" ? 500 : false),
	});

	useEffect(
		() => () => {
			if (active.current)
				void client.releaseDrawing(active.current).catch(() => {});
		},
		[client],
	);
	const ops = useQuery({
		queryKey: ["drawing-operations", client.identity],
		queryFn: ({ signal }) => client.drawingOperations(signal),
		refetchInterval: (q) =>
			q.state.data?.some((r) => ["planning", "starting"].includes(r.state))
				? 500
				: false,
	});
	const latestOp = ops.data?.[0];
	const refresh = refs.refetch;
	const shown = status.data?.id === session?.id ? status.data : session;
	const revision = Math.max(
		refs.dataUpdatedAt,
		status.dataUpdatedAt,
		session?.lastOperation ?? 0,
	);
	const operationId = latestOp?.id,
		operationState = latestOp?.state,
		operationSession = latestOp?.sessionId;
	useEffect(() => {
		if (
			!operationId ||
			operationState !== "completed" ||
			adoptedOperation.current === operationId
		)
			return;
		adoptedOperation.current = operationId;
		let disposed = false;
		const prior = active.current;
		void (async () => {
			const incoming = operationSession
				? await client.drawingSession(operationSession)
				: null;
			if (disposed) return;
			if (prior && prior !== incoming?.id)
				await client.releaseDrawing(prior).catch(() => {});
			if (disposed) return;
			active.current = incoming?.id ?? null;
			setSession(incoming);
			await refresh();
		})().catch(() => {
			if (!disposed) setError("編集画面の情報を取得できませんでした。");
		});
		return () => {
			disposed = true;
		};
	}, [
		operationId,
		operationState,
		operationSession,
		client,
		refresh,
		session?.id,
	]);

	const busy =
		shown?.state === "starting" ||
		(!!latestOp && ["planning", "starting"].includes(latestOp.state));
	const runtime: ArtifactRuntime = {
		snapshot: {
			drawings: {
				kind: "drawing-workspace",
				revision,
				references: refs.data ?? [],
				status: busy
					? "Excalidrawを準備中です。"
					: shown?.state === "ready"
						? "利用可能です。"
						: shown?.state === "idle"
							? "接続を解放しています。Excalidrawを開くと再接続します。"
							: shown?.state === "failed"
								? "起動できませんでした。接続設定を確認して再度開いてください。"
								: "保存済みの図を開くか、新しい図を作成できます。",
				error,
				busy,
				url: busy
					? undefined
					: (shown?.url ??
						(shown?.state === "idle" && latestOp?.sessionId === shown.id
							? (latestOp.url ?? undefined)
							: undefined)),
			},
		},
		dispatch: async (e) => {
			if (events.current.has(e.id))
				return { status: "duplicate", message: "実行済みです" };
			if (e.source !== "drawings" || e.revision !== revision || busy)
				return { status: "conflict", message: "画面を再表示してください" };
			if (
				!["drawing-new", "drawing-open", "drawing-refresh"].includes(e.action)
			)
				return { status: "rejected", message: "この操作は利用できません" };
			events.current.add(e.id);
			setError("");
			try {
				if (e.action === "drawing-refresh") await refs.refetch();
				else {
					const refId =
						e.action === "drawing-open" && typeof e.values.id === "string"
							? e.values.id
							: undefined;
					if (
						e.action === "drawing-open" &&
						!refs.data?.some((r) => r.id === refId)
					)
						throw new Error("図を確認できませんでした。");
					if (active.current) await client.releaseDrawing(active.current);
					const s = await client.openDrawing({
						requestId: e.id,
						...(refId ? { referenceId: refId } : {}),
					});
					active.current = s.id;
					setSession(s);
				}
				return { status: "accepted", message: "操作を受け付けました" };
			} catch {
				setError("Excalidrawに接続できませんでした。");
				return { status: "rejected", message: "接続できませんでした" };
			}
		},
	};
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
