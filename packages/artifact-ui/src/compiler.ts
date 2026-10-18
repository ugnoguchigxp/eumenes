import { createParser } from "./sdk";
import {
	type ArtifactDefinition,
	definitionRequests,
	definitionName,
	type Snapshot,
	parseDefinition,
	parseDocument,
} from "./contracts";
import { artifactLibrary } from "./library";

function checkSource(definition: ArtifactDefinition, snapshot: Snapshot) {
	for (const request of definitionRequests(definition)) {
		if (request.view === "service-test-workspace") {
			for (const source of [
				request.statusSource,
				request.catalogSource,
				request.runsSource,
				request.healthSource,
			])
				if (snapshot[source]?.kind !== "collection")
					throw new Error("この表示では参照できない source です");
			continue;
		}
		const kind = ["ocr-media", "ocr-panel"].includes(request.view)
			? "ocr-workspace"
			: [
						"image-workspace",
						"image-creation-form",
						"image-preview",
						"image-gallery",
				  ].includes(request.view)
				? "image-workspace"
				: request.view === "model3d-workspace"
					? "model3d"
					: request.view === "browser-workspace"
						? "browser"
						: request.view === "music-workspace" ||
							  request.view === "music-player" ||
							  request.view === "playlist" ||
							  request.view === "music-library"
							? "music"
							: request.view === "generation-status"
								? "generation"
								: request.view === "collection-workspace"
									? "collection"
									: request.view;
		if (request.source && snapshot[request.source]?.kind !== kind)
			throw new Error("この表示では参照できない source です");
	}
}
function serialize(value: unknown) {
	return JSON.stringify(value)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}
export function compileArtifact(input: string, snapshot: Snapshot) {
	const request = parseDefinition(input);
	checkSource(request, snapshot);
	const lang = `root = ${definitionName(request)}(${serialize(request)})`;
	validateParsed(lang, request);
	return { request, lang };
}
function validateParsed(lang: string, request: ArtifactDefinition) {
	const parsed = createParser(artifactLibrary.toJSONSchema()).parse(lang);
	if (
		!parsed.root ||
		parsed.root.partial ||
		parsed.root.typeName !== definitionName(request) ||
		parsed.meta.incomplete ||
		parsed.meta.errors.length ||
		parsed.meta.unresolved.length ||
		parsed.meta.orphaned.length ||
		parsed.meta.statementCount !== 1 ||
		parsed.queryStatements.length ||
		parsed.mutationStatements.length ||
		Object.keys(parsed.stateDeclarations).length
	)
		throw new Error("OpenUI の定義を検証できませんでした");
	parseDocument(parsed.root.props.request);
}
/** Showcase accepts only literal, registered view calls; never arbitrary Lang programs. */
export function compileLang(input: string, snapshot: Snapshot) {
	if (new TextEncoder().encode(input).length > 16_384)
		throw new Error("定義が大きすぎます");
	const match = /^\s*root\s*=\s*([A-Za-z]+)\((\{[\s\S]*\})\)\s*$/.exec(input);
	if (!match)
		throw new Error("root = 登録コンポーネント(JSON) の形式で指定してください");
	const request = parseDocument(JSON.parse(match[2]!));
	if (match[1] !== definitionName(request))
		throw new Error("コンポーネントと view が一致しません");
	return compileArtifact(serialize(request), snapshot);
}
