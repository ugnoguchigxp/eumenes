import { createRoot } from "react-dom/client";
import { ArtifactRenderer } from "../../packages/artifact-ui/src";

const conversationId =
	new URLSearchParams(location.search).get("conversationId") ??
	"canvas-browser";
createRoot(document.getElementById("root")!).render(
	<ArtifactRenderer
		definition={JSON.stringify({
			view: "canvas-workspace",
			title: "Canvasアプリ",
			source: "canvas",
		})}
		runtime={{
			snapshot: {
				canvas: {
					kind: "canvas-workspace",
					revision: 1,
					conversationId,
					visible: true,
				},
			},
			dispatch: async () => ({
				status: "rejected",
				message: "この検証では使いません。",
			}),
		}}
	/>,
);
