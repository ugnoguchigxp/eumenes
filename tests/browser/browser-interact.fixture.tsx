import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactRenderer, type ArtifactEvent } from "@eumenes/artifact-ui";
import "@eumenes/design-system/styles";
import { ArtifactPanel } from "../../web/src/components/domains/artifact/ArtifactPanel";
import {
	interactSnapshot,
	type InteractWorkspace,
} from "../../web/src/domains/browser/interact/view-model";
import bundle from "../../api/domains/capabilities/bundles/browser-interact.bundle.json";
const FIXTURE_NOW = Date.now();
const initial: NonNullable<InteractWorkspace["selected"]> = {
	runId: "r1",
	conversationId: "main",
	parentExecutionId: null,
	state: "needs_input",
	code: null,
	generation: 1,
	revision: 2,
	calls: 1,
	deadline: FIXTURE_NOW + 60000,
	question: {
		id: "q1",
		kind: "approval",
		text: "この操作を一度実行してよいですか。\n対象: 申込ボタン\nページ: https://example.com/form",
		deadline: FIXTURE_NOW + 60000,
	},
	answer: null,
	captures: [],
};
declare global {
	interface Window {
		interactFixture: {
			nextQuestion: () => void;
			nextRun: () => void;
			parent: () => void;
			events: ArtifactEvent[];
		};
	}
}
window.interactFixture = {
	nextQuestion() {},
	nextRun() {},
	parent() {},
	events: [],
};
function Fixture() {
	const [run, setRun] = useState(initial);
	useEffect(() => {
		window.interactFixture.nextQuestion = () =>
			setRun({
				...initial,
				generation: 2,
				revision: 3,
				question: { ...initial.question!, id: "q2" },
			});
		window.interactFixture.nextRun = () =>
			setRun({ ...initial, runId: "r2", revision: 4 });
		window.interactFixture.parent = () =>
			setRun({ ...initial, parentExecutionId: "parent" });
	}, []);
	const snapshot = interactSnapshot(
		{ runs: [run], selected: run },
		"main",
		FIXTURE_NOW,
	);
	return (
		<ArtifactPanel
			tabs={[
				{
					id: "interact",
					kind: "toolchain",
					title: "ブラウザ作業（検証）",
					artifactRevisionId: "artifact:browser.interact.workspace@1",
				},
			]}
			activeTabId="interact"
			onSelect={() => {}}
			onClose={() => {}}
			renderToolchain={() => (
				<ArtifactRenderer
					definition={JSON.stringify(
						bundle.artifacts[0]!.variants[0]!.definition,
					)}
					runtime={{
						snapshot,
						dispatch: async (e) => {
							window.interactFixture.events.push(e);
							return { status: "accepted", message: "受け付けました" };
						},
					}}
				/>
			)}
		/>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
