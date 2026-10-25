import type {
	Resource,
	Snapshot,
	UiStudioResource,
} from "@eumenes/artifact-ui/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { focusWhenDrawn } from "../../components/domains/resource-focus";
import { queryRoots } from "../../queryKeys";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import {
	type BridgeResult,
	useSpecialistBridge,
} from "../toolchain-artifacts/specialist-bridge";

const UI_COMPOSITIONS_ADAPTER_REF = "adapter:ui-compositions@1";
/** The studio's artifact id, as a launcher or a navigation names it. */
export const UI_STUDIO_ARTIFACT_ID = "ui.studio";

/** What the mounted studio shows, read through the latest render. */
type StudioScreen = {
	targetRef: string | undefined;
	/** The saved composition the studio has loaded for display. */
	viewingId: string | undefined;
	visible: boolean;
	show(compositionId: string): void;
};
const live = createLiveScreen<{ read(): StudioScreen }>();

const workSchema = z.object({
	workRef: z.string(),
	sessionId: z.string(),
	title: z.string(),
	definition: z.unknown(),
	revision: z.number().int(),
	source: z.string(),
	previousSource: z.string(),
	rejected: z
		.object({
			title: z.string(),
			text: z.string(),
			issues: z.array(z.object({ path: z.string(), rule: z.string() })),
			fixes: z.array(z.string()),
			createdAt: z.string(),
		})
		.nullable(),
	savedRef: z.string().nullable(),
	savedRevision: z.number().int().nullable(),
	dirty: z.boolean(),
	busy: z.boolean(),
	canUndo: z.boolean(),
	canRedo: z.boolean(),
});
const studioSchema = z.object({
	kind: z.literal("ui-studio"),
	work: workSchema.nullable(),
	viewing: z
		.object({
			id: z.string(),
			title: z.string(),
			definition: z.unknown(),
			storedDefinition: z.unknown().optional(),
			savedRevision: z.number().int(),
		})
		.nullable(),
	history: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			updatedAt: z.union([z.string(), z.number()]),
		}),
	),
});
const rejected = (message: string) => ({
	status: "rejected" as const,
	message,
});
/** Wording for a refused source apply; the detail ("path: rule") follows when the server names one. */
const sourceRefusals: Record<string, string> = {
	ui_definition_invalid: "定義の検査を通りませんでした",
	document_parse_failed: "JSONとして読み取れませんでした",
	generation_in_progress: "制作中のため、今は反映できません",
};
const receiptOf = (result: BridgeResult, message: string) =>
	result.ok
		? { status: "accepted" as const, message }
		: rejected(result.message);

export const uiCompositionsWebAdapter: WebArtifactAdapter = {
	adapterRef: UI_COMPOSITIONS_ADAPTER_REF,
	useArtifact({
		client,
		artifactRevisionId,
		targetRef,
		setTargetRef,
		visible,
	}) {
		const cache = useQueryClient();
		const bridge = useSpecialistBridge();
		const session = bridge?.session ?? null;
		const root = [
			queryRoots.toolchainArtifacts,
			client.identity,
			"ui-compositions",
		];

		const studio = useQuery({
			queryKey: [...root, "studio", artifactRevisionId, targetRef ?? null],
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"ui-studio",
					targetRef,
					signal,
				),
			enabled: visible,
			// While a turn is running the draft changes under the screen.
			refetchInterval: (query) => {
				const work = (
					query.state.data?.data as { work?: { busy?: boolean } | null }
				)?.work;
				return work?.busy || session?.busy ? 1000 : false;
			},
		});
		// A spoken return/discard or expiry can finish an idle work without a local action.
		// Session transitions must refresh the source even when the busy poll is stopped.
		// A turn always touches `updatedAt`, so a draft applied by a turn too quick to be seen
		// running (activeRunId set and cleared between two reads) still refreshes the source.
		const sessionKey = session
			? `${session.id}:${session.state}:${session.revision}:${session.activeRunId ?? ""}:${session.updatedAt}`
			: "none";
		useEffect(() => {
			void cache.invalidateQueries({
				queryKey: [
					queryRoots.toolchainArtifacts,
					client.identity,
					"ui-compositions",
				],
			});
		}, [cache, client.identity, sessionKey]);
		const parsedStudio = studioSchema.safeParse(studio.data?.data);
		const viewing = parsedStudio.success ? parsedStudio.data.viewing : null;
		const form = useQuery({
			queryKey: [...root, "form", artifactRevisionId, targetRef ?? null],
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"composition-form",
					targetRef,
					signal,
				),
			// Only a saved work has a form to answer; wait until it is shown.
			enabled: visible && !!targetRef && viewing?.id === targetRef,
			retry: false,
		});
		const snapshot: Record<string, Resource> = {};
		if (parsedStudio.success && studio.data) {
			const { work, history } = parsedStudio.data;
			snapshot["ui-studio"] = {
				kind: "ui-studio",
				revision: studio.data.revision,
				work,
				viewing,
				history,
				session:
					session &&
					session.artifactRevisionId === artifactRevisionId &&
					(session.state === "active" || session.state === "suspended")
						? { state: session.state, expiresAt: session.expiresAt }
						: null,
				stoppable: !!session?.activeRunId,
			} satisfies UiStudioResource;
		}
		if (
			viewing &&
			form.data?.data &&
			(form.data.data as { kind?: string }).kind === "form"
		)
			snapshot["composition-form"] = {
				...(form.data.data as Resource),
				revision: form.data.revision,
			};
		const refresh = () => {
			void cache.invalidateQueries({ queryKey: root });
		};
		const screen: StudioScreen = {
			targetRef,
			viewingId: viewing?.id,
			visible,
			show: setTargetRef,
		};
		const latest = useRef(screen);
		useEffect(() => {
			latest.current = screen;
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase:
				studio.isError || (studio.data && !parsedStudio.success)
					? { kind: "error", message: "UI制作の情報を読み込めません。" }
					: studio.data
						? { kind: "ready" }
						: { kind: "loading" },
			snapshot: snapshot as Snapshot,
			targetOf: (source) =>
				source === "composition-form" ? targetRef : undefined,
			local: async (binding, event) => {
				switch (binding.eventAction) {
					case "ui-select":
					case "ui-retarget": {
						const id = event.values.id;
						const known =
							parsedStudio.success &&
							parsedStudio.data.history.some((item) => item.id === id);
						if (typeof id !== "string" || (id && !known))
							return rejected("作品が見つかりません。");
						const work = parsedStudio.success ? parsedStudio.data.work : null;
						// While the specialist is active, the chosen saved work becomes what it edits.
						const editing =
							bridge &&
							work &&
							session?.state === "active" &&
							session.artifactRevisionId === artifactRevisionId;
						if (!id || !editing) {
							setTargetRef(id || undefined);
							return { status: "accepted", message: "" };
						}
						if (work.savedRef === id) {
							setTargetRef(undefined);
							return { status: "accepted", message: "" };
						}
						if (work.busy) {
							setTargetRef(id);
							return {
								status: "accepted",
								message: "制作中のため、表示だけを切り替えました。",
							};
						}
						// `ui-retarget` is the user's choice to discard the unsaved draft for it.
						const result = await bridge.retarget(
							id,
							binding.eventAction === "ui-retarget",
						);
						if (result.ok) {
							setTargetRef(undefined);
							refresh();
						}
						return receiptOf(result, "選んだ作品の編集に切り替えました。");
					}
					case "ui-refresh":
						refresh();
						return { status: "accepted", message: "更新しました。" };
					case "ui-stop":
						if (!bridge) return rejected("この操作は利用できません。");
						return receiptOf(await bridge.stopRun(), "停止を依頼しました。");
					case "ui-close":
						if (!bridge) return rejected("この操作は利用できません。");
						return receiptOf(await bridge.requestClose(artifactRevisionId), "");
					case "ui-return":
					case "ui-resume":
					case "ui-discard": {
						if (!bridge) return rejected("この操作は利用できません。");
						const kind = binding.eventAction.slice(3) as
							| "return"
							| "resume"
							| "discard";
						const result = await bridge.command(kind);
						if (result.ok) {
							// A resumed draft and a discarded one are shown from the start.
							if (kind !== "return") setTargetRef(undefined);
							refresh();
						}
						return receiptOf(
							result,
							kind === "return"
								? "通常の会話に戻りました。"
								: kind === "resume"
									? "編集を再開しました。"
									: "未保存の案を破棄しました。",
						);
					}
					default:
						return rejected("この操作は利用できません。");
				}
			},
			settled: async (binding, result) => {
				refresh();
				// A deleted work is gone from the screen: show the draft, or the empty state.
				if (binding.eventAction === "ui-delete") {
					const deleted = result.resultRefs.find(
						(ref) => ref.owner === "ui-compositions",
					)?.id;
					if (deleted === targetRef) setTargetRef(undefined);
					return;
				}
				if (binding.eventAction !== "ui-save" || !bridge) return;
				// A saved work that was only suspended is finished: close it and show the saved copy.
				if (session?.state === "suspended") {
					const savedId =
						result.resultRefs.find((ref) => ref.owner === "ui-compositions")
							?.id ??
						(parsedStudio.success ? parsedStudio.data.work?.savedRef : null);
					const closed = await bridge.closeSession();
					if (closed.ok && savedId) setTargetRef(savedId);
				}
			},
			refresh,
			describeRejection(code, fieldErrors) {
				const reason = code ? sourceRefusals[code] : undefined;
				if (!code || !reason) return undefined;
				const detail = fieldErrors
					.map(({ field, message }) => `${field}: ${message}`)
					.join("、");
				return `${reason}（${code}${detail ? `・${detail}` : ""}）。`;
			},
		};
	},
	async focus(compositionId) {
		const mounted = await live.waitFor((handle) => handle.read());
		if (!mounted) return false;
		// Showing a saved work is a display change only; the specialist's draft is not touched.
		if (mounted.targetRef !== compositionId) mounted.show(compositionId);
		const shown = await live.waitFor(
			(handle) => handle.read().viewingId === compositionId,
		);
		if (!shown) return false;
		// The composition exists; marking it is best effort while the studio draws it.
		await focusWhenDrawn(() =>
			document.querySelector<HTMLElement>(".aui-ui-studio"),
		);
		return true;
	},
	viewing() {
		const screen = live.current()?.read();
		return screen?.visible && screen.viewingId
			? formatResourceUri("ui.composition", screen.viewingId)
			: null;
	},
};
