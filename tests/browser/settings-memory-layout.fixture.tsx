import { createRoot } from "react-dom/client";
import { ArtifactRenderer } from "@eumenes/artifact-ui";
import "@eumenes/design-system/styles";
import "@eumenes/artifact-ui/styles";
import memoryBundle from "../../api/domains/capabilities/bundles/settings-memory.bundle.json";
import { artifactDefinitionV1 } from "../../api/domains/capabilities/contracts";
import {
	collectionResource,
	defaultPaging,
} from "../../web/src/domains/toolchain-artifacts/collections";

const artifact = artifactDefinitionV1.parse(memoryBundle.artifacts[0]);
const text =
	"週末の読書会について、参加者から候補日を集めて日程を調整する。".repeat(4);
const memory = {
	id: "memory",
	kindLabel: "本人の事実",
	text,
	statusLabel: "利用中",
	capturedByLabel: "会話から自動で記憶",
	quote: "来月も読書会に参加します。",
};
const rows: Record<string, object[]> = {
	"memory-items": [memory],
	"memory-short-term": [
		{
			id: "note",
			kindLabel: "未解決",
			text,
			originLabel: "会話から自動で記録",
		},
		{
			id: "expiring-note",
			kindLabel: "活動",
			text: "候補日を共有する。",
			originLabel: "手動登録",
			expiresAt: Date.UTC(2026, 10, 21, 14),
		},
	],
	"memory-history": [{ ...memory, statusLabel: "置き換え済み" }],
};
const snapshot = Object.fromEntries(
	(artifact.collections ?? []).map((collection) => [
		collection.source,
		collectionResource({
			collection,
			data: { items: rows[collection.source] ?? [] },
			bindings: artifact.actionBindings,
			revision: 0,
			query: defaultPaging,
			busy: false,
		}),
	]),
);

createRoot(document.getElementById("root")!).render(
	<ArtifactRenderer
		definition={JSON.stringify(artifact.variants[0]!.definition)}
		runtime={{
			snapshot,
			dispatch: async () => ({ status: "accepted", message: "" }),
		}}
	/>,
);
