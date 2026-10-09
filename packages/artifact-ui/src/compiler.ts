import { createParser } from "@openuidev/react-lang";
import { type ArtifactRequest, type Snapshot, parseDefinition, parseRequest, viewRegistry } from "./contracts";
import { artifactLibrary } from "./library";

export function checkSource(request: ArtifactRequest, snapshot: Snapshot) {
	if (request.source && snapshot[request.source]?.kind !== request.view)
		throw new Error("この表示では参照できない source です");
}
function serialize(value: unknown) {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
export function compileArtifact(input: string, snapshot: Snapshot) {
	const request = parseDefinition(input);
	checkSource(request, snapshot);
	const lang = `root = ${viewRegistry[request.view].name}(${serialize(request)})`;
	validateParsed(lang, request);
	return { request, lang };
}
function validateParsed(lang: string, request: ArtifactRequest) {
	const parsed = createParser(artifactLibrary.toJSONSchema()).parse(lang);
	if (!parsed.root || parsed.root.partial || parsed.root.typeName !== viewRegistry[request.view].name || parsed.meta.incomplete || parsed.meta.errors.length || parsed.meta.unresolved.length || parsed.meta.orphaned.length || parsed.meta.statementCount !== 1 || parsed.queryStatements.length || parsed.mutationStatements.length || Object.keys(parsed.stateDeclarations).length)
		throw new Error("OpenUI の定義を検証できませんでした");
	parseRequest(parsed.root.props.request);
}
/** Showcase accepts only literal, registered view calls; never arbitrary Lang programs. */
export function compileLang(input: string, snapshot: Snapshot) {
	if (new TextEncoder().encode(input).length > 16_384) throw new Error("定義が大きすぎます");
	const match = /^\s*root\s*=\s*([A-Za-z]+)\((\{[\s\S]*\})\)\s*$/.exec(input);
	if (!match) throw new Error("root = 登録コンポーネント(JSON) の形式で指定してください");
	const request = parseRequest(JSON.parse(match[2]!));
	if (match[1] !== viewRegistry[request.view].name) throw new Error("コンポーネントと view が一致しません");
	return compileArtifact(serialize(request), snapshot);
}
