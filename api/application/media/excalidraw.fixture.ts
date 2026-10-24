import type { LarmPort } from "../../domains/larm";
import { drawingFixture } from "../../domains/excalidraw/test/connection.fixture";
import {
	activeSlots,
	answerUtterance,
	handOver,
} from "./conversation-turn.fixture";
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
			const turn = answerUtterance(
				options?.tools,
				messages,
				options?.onToolCalls,
				handOver("excalidraw.edit", "準備します。"),
				() => stages.push("route"),
			);
			if (turn !== undefined) return turn;
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
			const result =
				(activeSlots(messages).at(-1)?.result as
					| { url?: string }
					| undefined) ?? null;
			return result?.url
				? `編集画面を開けます。[Excalidrawを開く](${result.url})`
				: "図の一覧を開きました。";
		},
	};
	return { ...external, model, stages, contexts };
}
