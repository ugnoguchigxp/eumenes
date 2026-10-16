import type { LarmPort } from "../../domains/larm";
import { drawingFixture } from "../../domains/excalidraw/test/connection.fixture";
export function excalidrawFixture(action: "create" | "library" = "create") {
	const external = drawingFixture(),
		stages: string[] = [],
		contexts: string[] = [];
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, options) => {
			contexts.push(JSON.stringify(messages));
			if (options?.tools?.length) {
				stages.push("route");
				options.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: "drawing_editor",
						arguments: JSON.stringify({ request: "新しい図を描く画面を開く" }),
					},
				]);
				return "";
			}
			if (messages[0]?.content.includes("OUTPUT_SCHEMA=")) {
				stages.push("plan");
				return JSON.stringify({
					action,
					referenceId: null,
					revision: null,
					title: "構成図",
				});
			}
			stages.push("answer");
			const r = messages.find((m) => m.content.includes('"drawingResult"'));
			const result = r ? JSON.parse(r.content).drawingResult : null;
			return result?.url
				? `編集画面を開けます。[Excalidrawを開く](${result.url})`
				: "図の一覧を開きました。";
		},
	};
	return { ...external, model, stages, contexts };
}
