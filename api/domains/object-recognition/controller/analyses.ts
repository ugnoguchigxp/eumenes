import type { Hono } from "hono";
import { registerMediaAnalyses } from "../../../infrastructure/media-analysis-http";
import type { MediaAnalyses } from "../../../infrastructure/media-analysis";
import {
	analysisCreate,
	type AnalysisCreate,
	type AnalysisRecord,
} from "../../larm";
export function registerRecognitionAnalyses(
	app: Hono,
	service: MediaAnalyses<AnalysisRecord, AnalysisCreate>,
	owner: string,
) {
	registerMediaAnalyses(
		app,
		"/api/object-recognition/:id/analyses",
		service,
		owner,
		analysisCreate,
	);
}
