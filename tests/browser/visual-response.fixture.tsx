import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VisualAnalysis } from "@eumenes/design-system";
import { createClient } from "../../client";
import { useVisualAnalysis } from "../../web/src/hooks/use-visual-analysis";

const client = createClient("http://127.0.0.1:18701");
const source = {
	id: "00000000-0000-4000-8000-000000000001",
	revision: 1,
	mime: "image/png",
	state: "completed",
	result: { kind: "image" },
};
function Fixture() {
	const analysis = useVisualAnalysis(
		client,
		"object-recognition",
		"main",
		source,
		0,
	);
	return (
		<VisualAnalysis
			{...analysis.resource}
			onAnalysisOpen={() => {
				void analysis.dispatch({
					id: crypto.randomUUID(),
					source: "recognition",
					revision: analysis.revision,
					action: "analysis-open",
					values: { id: source.id, scope: analysis.resource.analysisScope },
				});
			}}
			onAnalysisCancel={() => {
				void analysis.dispatch({
					id: crypto.randomUUID(),
					source: "recognition",
					revision: analysis.revision,
					action: "analysis-cancel",
					values: {
						id: source.id,
						scope: analysis.resource.analysisScope,
						analysisId: analysis.resource.analysis?.id ?? "",
					},
				});
			}}
		/>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<Fixture />
	</QueryClientProvider>,
);
