import type {
	PipelineStudioResource,
	Resource,
	Snapshot,
} from "@eumenes/artifact-ui/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { queryRoots } from "../../queryKeys";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import {
	type BridgeResult,
	useSpecialistBridge,
} from "../toolchain-artifacts/specialist-bridge";

const PIPELINES_ADAPTER_REF = "adapter:pipelines@1";
/** The studio's artifact id, as a launcher or a navigation names it. */
export const PIPELINE_STUDIO_ARTIFACT_ID = "pipeline.studio";

const issueSchema = z.object({
	pointer: z.string(),
	rule: z.string(),
	line: z.number().int().nullable(),
});
const stepSchema = z.object({
	id: z.string(),
	kind: z.enum(["toolchain", "extract"]),
	title: z.string(),
	toolchain: z.string().nullable(),
	reads: z.array(z.string()),
	inputs: z.array(z.string()),
});
const workSchema = z.object({
	workRef: z.string(),
	sessionId: z.string(),
	title: z.string(),
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
	issues: z.array(issueSchema),
	flow: z
		.object({
			inputs: z.array(
				z.object({
					name: z.string(),
					type: z.string(),
					required: z.boolean(),
				}),
			),
			steps: z.array(stepSchema),
			answer: z
				.object({ inputs: z.array(z.string()), reads: z.array(z.string()) })
				.nullable(),
		})
		.nullable(),
	tests: z.array(z.object({ index: z.number().int(), utterance: z.string() })),
	published: z
		.object({
			toolchainRevisionId: z.string(),
			functionName: z.string(),
			revision: z.number().int(),
		})
		.nullable(),
	dirty: z.boolean(),
	busy: z.boolean(),
});
const studioSchema = z.object({
	work: workSchema.nullable(),
	history: z.array(
		z.object({
			toolchainId: z.string(),
			title: z.string(),
			toolchainRevisionId: z.string(),
		}),
	),
});
/** The domain receipt of a publish: the id of the published pipeline's toolchain. */
const publishedSchema = z.object({
	state: z.literal("published"),
	toolchainId: z.string(),
});
type Trial = NonNullable<PipelineStudioResource["trial"]>;
/** The last trial with the draft it ran against: a changed draft makes it stale. */
type Held = { workRef: string; revision: number; trial: Trial };

const rejected = (message: string) => ({
	status: "rejected" as const,
	message,
});
/** Wording for a refused write; the detail ("path: rule") follows when the server names one. */
const writeRefusals: Record<string, string> = {
	pipeline_invalid: "パイプラインの検査を通りませんでした",
	document_parse_failed: "JSONとして読み取れませんでした",
	revision_conflict:
		"ほかの更新と重なりました。表示を更新して、もう一度お試しください",
	work_busy: "制作中のため、今は反映・公開できません",
	session_expired: "制作の期限が切れました。編集を始め直してください",
};
const receiptOf = (result: BridgeResult, message: string) =>
	result.ok
		? { status: "accepted" as const, message }
		: rejected(result.message);

export const pipelinesWebAdapter: WebArtifactAdapter = {
	adapterRef: PIPELINES_ADAPTER_REF,
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
		const root = [queryRoots.toolchainArtifacts, client.identity, "pipelines"];
		const [held, setHeld] = useState<Held | null>(null);
		// A later trial supersedes an earlier one that is still running.
		const trialSeq = useRef(0);

		const studio = useQuery({
			queryKey: [...root, "studio", artifactRevisionId, targetRef ?? null],
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"pipeline-studio",
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
		// A spoken return/discard or expiry can finish an idle work without a local action, and a
		// turn too quick to be seen running still touches `updatedAt`: refresh on any session change.
		const sessionKey = session
			? `${session.id}:${session.state}:${session.revision}:${session.activeRunId ?? ""}:${session.updatedAt}`
			: "none";
		useEffect(() => {
			void cache.invalidateQueries({
				queryKey: [queryRoots.toolchainArtifacts, client.identity, "pipelines"],
			});
		}, [cache, client.identity, sessionKey]);
		const parsed = studioSchema.safeParse(studio.data?.data);
		const work = parsed.success ? parsed.data.work : null;
		const history = parsed.success ? parsed.data.history : [];
		const snapshot: Record<string, Resource> = {};
		if (parsed.success && studio.data)
			snapshot["pipeline-studio"] = {
				kind: "pipeline-studio",
				revision: studio.data.revision,
				work,
				history,
				session:
					session &&
					session.artifactRevisionId === artifactRevisionId &&
					(session.state === "active" || session.state === "suspended")
						? { state: session.state, expiresAt: session.expiresAt }
						: null,
				stoppable: !!session?.activeRunId,
				// A result for an older draft is not the draft's result any more.
				trial:
					held &&
					work &&
					held.workRef === work.workRef &&
					held.revision === work.revision
						? held.trial
						: null,
			} satisfies PipelineStudioResource;
		const refresh = () => {
			void cache.invalidateQueries({ queryKey: root });
		};
		/** Runs one trial of the current draft; the screen shows it pending, then its result. */
		const runTrial = async (
			start: Trial,
			run: (workRef: string) => Promise<NonNullable<Trial["result"]>>,
			failure: NonNullable<Trial["result"]>,
		) => {
			if (!work) return rejected("制作中の下書きがありません。");
			const at = { workRef: work.workRef, revision: work.revision };
			const seq = (trialSeq.current += 1);
			setHeld({ ...at, trial: start });
			let result: NonNullable<Trial["result"]>;
			try {
				result = await run(work.workRef);
			} catch {
				result = failure;
			}
			if (seq === trialSeq.current)
				setHeld({
					...at,
					trial: { ...start, pending: false, result } as Trial,
				});
			return { status: "accepted" as const, message: "" };
		};
		return {
			phase:
				studio.isError || (studio.data && !parsed.success)
					? {
							kind: "error",
							message: "パイプライン制作の情報を読み込めません。",
						}
					: studio.data
						? { kind: "ready" }
						: { kind: "loading" },
			snapshot: snapshot as Snapshot,
			targetOf: () => undefined,
			local: async (binding, event) => {
				switch (binding.eventAction) {
					case "pipeline-probe": {
						const query = event.values.query;
						if (typeof query !== "string" || query.trim() === "")
							return rejected("確認することばを入力してください。");
						return runTrial(
							{ kind: "probe", query, pending: true, result: null },
							(workRef) => client.pipelines.probe(workRef, query),
							{ ok: false, code: "request_failed" },
						);
					}
					case "pipeline-select": {
						const utterance = event.values.utterance;
						if (typeof utterance !== "string" || utterance.trim() === "")
							return rejected("発話を入力してください。");
						return runTrial(
							{ kind: "select", utterance, pending: true, result: null },
							(workRef) => client.pipelines.select(workRef, utterance),
							{ ok: false, code: "request_failed" },
						);
					}
					case "pipeline-fixture": {
						const test = Number(event.values.test);
						if (
							!Number.isInteger(test) ||
							!work?.tests.some((item) => item.index === test)
						)
							return rejected("試験例が見つかりません。");
						return runTrial(
							{ kind: "fixture", test, pending: true, result: null },
							(workRef) => client.pipelines.fixture(workRef, test),
							{
								ok: false,
								issues: [{ pointer: "", rule: "request_failed" }],
							},
						);
					}
					case "pipeline-open": {
						const id = event.values.toolchainId;
						const item =
							typeof id === "string" && id
								? history.find((entry) => entry.toolchainId === id)
								: undefined;
						if (typeof id !== "string" || (id && !item))
							return rejected("パイプラインが見つかりません。");
						// While the specialist is active, the chosen pipeline becomes what it edits.
						const editing =
							bridge &&
							work &&
							session?.state === "active" &&
							session.artifactRevisionId === artifactRevisionId;
						if (!id || !editing) {
							setTargetRef(id || undefined);
							return { status: "accepted", message: "" };
						}
						if (
							work.published?.toolchainRevisionId === item?.toolchainRevisionId
						) {
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
						// Unpublished work is never dropped for it: the bridge refuses and says so.
						const result = await bridge.retarget(id, false);
						if (result.ok) {
							setTargetRef(undefined);
							refresh();
						}
						return receiptOf(
							result,
							"選んだパイプラインの編集に切り替えました。",
						);
					}
					case "pipeline-refresh":
						refresh();
						return { status: "accepted", message: "更新しました。" };
					case "pipeline-stop":
						if (!bridge) return rejected("この操作は利用できません。");
						return receiptOf(await bridge.stopRun(), "停止を依頼しました。");
					case "pipeline-close":
						if (!bridge) return rejected("この操作は利用できません。");
						return receiptOf(await bridge.requestClose(artifactRevisionId), "");
					case "pipeline-return":
					case "pipeline-resume": {
						if (!bridge) return rejected("この操作は利用できません。");
						const kind = binding.eventAction.slice("pipeline-".length) as
							| "return"
							| "resume";
						const result = await bridge.command(kind);
						if (result.ok) {
							// A resumed draft is shown from the start.
							if (kind === "resume") setTargetRef(undefined);
							refresh();
						}
						return receiptOf(
							result,
							kind === "return"
								? "通常の会話に戻りました。"
								: "編集を再開しました。",
						);
					}
					default:
						return rejected("この操作は利用できません。");
				}
			},
			settled: async (binding, result) => {
				// A text that failed the format check is accepted as a receipt: the read shows it as
				// the work's rejected draft.
				refresh();
				if (binding.eventAction !== "pipeline-publish" || !bridge) return;
				// A published work that was only suspended is finished: close it and show the published copy.
				if (session?.state === "suspended") {
					const published = publishedSchema.safeParse(result.receipt);
					const toolchainId = published.success
						? published.data.toolchainId
						: result.resultRefs.find((ref) => ref.owner === "pipelines")?.id;
					const closed = await bridge.closeSession();
					if (closed.ok && toolchainId) setTargetRef(toolchainId);
				}
			},
			refresh,
			describeRejection(code, fieldErrors) {
				const reason = code ? writeRefusals[code] : undefined;
				if (!code || !reason) return undefined;
				const detail = fieldErrors
					.map(({ field, message }) => `${field}: ${message}`)
					.join("、");
				return `${reason}（${code}${detail ? `・${detail}` : ""}）。`;
			},
		};
	},
};
