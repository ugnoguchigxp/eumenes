import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PipelineStudioView } from "../../packages/artifact-ui/src/pipeline-studio-components";
import { ArtifactRuntimeContext } from "../../packages/artifact-ui/src/runtime";
import type {
	ArtifactEvent,
	Receipt,
} from "../../packages/artifact-ui/src/contracts";
import type { PipelineStudioResource } from "../../packages/artifact-ui/src/pipeline-studio-contracts";
import "@eumenes/design-system/styles";

declare global {
	interface Window {
		pipelineHandoff: {
			events: ArtifactEvent[];
			audio: string;
			playCalls: number;
		};
	}
}
const definition = {
	inputs: { topic: { type: "string", description: "テーマ", required: true } },
	steps: [
		{
			id: "research",
			kind: "toolchain",
			title: "素材を調べる",
			toolchain: "web.search",
			request: "${inputs.topic}を調べる",
		},
		{
			id: "compose",
			kind: "toolchain",
			title: "作品を作る",
			toolchain: "image.create",
			request: "${steps.research.summary}を参考に作る",
		},
	],
	tests: [
		{
			stepResults: {
				research: {
					output: {
						document: { title: "資料", fileRef: "document-1" },
						list: [0, false, null, ""],
					},
				},
			},
		},
	],
};
const initial: PipelineStudioResource = {
	kind: "pipeline-studio",
	revision: 3,
	work: {
		workRef: "work-1",
		sessionId: "session-1",
		title: "素材から作品を作る",
		revision: 3,
		source: JSON.stringify(definition, null, 2),
		previousSource: "",
		rejected: null,
		issues: [],
		flow: {
			inputs: [{ name: "topic", type: "string", required: true }],
			steps: [
				{
					id: "research",
					kind: "toolchain",
					title: "素材を調べる",
					toolchain: "web.search",
					reads: [],
					inputs: ["topic"],
				},
				{
					id: "compose",
					kind: "toolchain",
					title: "作品を作る",
					toolchain: "image.create",
					reads: ["research"],
					inputs: [],
				},
			],
			answer: null,
		},
		tests: [],
		published: null,
		dirty: true,
		busy: false,
	},
	history: [],
	session: { state: "active", expiresAt: "2026-10-23T00:00:00Z" },
	stoppable: false,
	trial: null,
	library: { kind: null, loading: false, query: "", images: [], tracks: [] },
};
const images = Array.from({ length: 7 }, (_, i) => ({
	id: `image-${i + 1}`,
	title: `保存画像${i + 1}`,
	thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="180"><rect width="256" height="180" fill="hsl(${i * 35} 25% 35%)"/><circle cx="128" cy="90" r="45" fill="#e9d9b9"/></svg>`)}`,
}));
function Fixture() {
	const [resource, setResource] = useState(initial);
	const dispatch = async (event: ArtifactEvent): Promise<Receipt> => {
		window.pipelineHandoff.events.push(event);
		if (event.action === "pipeline-library")
			setResource((r) => ({
				...r,
				library: {
					kind:
						event.values.kind === "close"
							? null
							: (event.values.kind as "image" | "music"),
					loading: false,
					query: String(event.values.query ?? ""),
					images,
					tracks: [
						{
							id: "track-1",
							title: "静かな午後",
							durationSeconds: 1,
							audioUrl: window.pipelineHandoff.audio,
						},
						{
							id: "track-2",
							title: "夜の余韻",
							durationSeconds: 1,
							audioUrl: window.pipelineHandoff.audio,
						},
					],
				},
			}));
		if (event.action === "pipeline-source-apply") {
			if (Number(event.values.expectedRevision) !== resource.work!.revision)
				return { status: "rejected", message: "更新が競合しました" };
			setResource((r) => ({
				...r,
				revision: r.revision + 1,
				work: {
					...r.work!,
					revision: r.work!.revision + 1,
					previousSource: r.work!.source,
					source: String(event.values.text),
				},
			}));
		}
		return { status: "accepted", message: "" };
	};
	return (
		<main className="fixture-layout">
			<section className="fixture-chat">
				<h2>Eumenes</h2>
				<p>素材を選んで、作品を作る手順を編集しています。</p>
				<textarea aria-label="会話の入力" placeholder="メッセージを入力" />
			</section>
			<aside className="fixture-artifact">
				<header>パイプライン制作</header>
				<div className="fixture-artifact-body">
					<ArtifactRuntimeContext.Provider
						value={{ snapshot: { "pipeline-studio": resource }, dispatch }}
					>
						<PipelineStudioView
							request={
								{
									view: "pipeline-studio",
									source: "pipeline-studio",
									title: "パイプライン制作",
								} as never
							}
						/>
					</ArtifactRuntimeContext.Provider>
				</div>
			</aside>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
