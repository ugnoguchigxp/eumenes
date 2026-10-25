import type { VisualAnalysisProps } from "@eumenes/design-system";
import type { useAction } from "./components";
export function visualAnalysisActions(
	action: ReturnType<typeof useAction>,
	resource: VisualAnalysisProps & { selectedId?: string },
) {
	const context = {
		id: resource.selectedId ?? "",
		scope: resource.analysisScope ?? "",
	};
	return {
		onAnalysisOpen: () => {
			void action.send("analysis-open", context);
		},
		onAnalysisRun: (
			options: Parameters<NonNullable<VisualAnalysisProps["onAnalysisRun"]>>[0],
		) => {
			void action.send("analysis-run", {
				...context,
				options: JSON.stringify(options),
			});
		},
		onAnalysisCancel: () => {
			void action.send("analysis-cancel", {
				...context,
				analysisId: resource.analysis?.id ?? "",
			});
		},
		onAnalysisSelect: (id: string) => {
			void action.send("analysis-select", { ...context, analysisId: id });
		},
	};
}
