// Check the TypeScript language service using a checkout-local tsconfig that extends
// the generated, Git-excluded configuration. No local package installation is used.
import { resolve } from "node:path";
import type TypeScript from "typescript";

const [checkout, compiler, shared] = process.argv.slice(2);
const ts = require(resolve(compiler, "typescript.js")) as typeof TypeScript;
const configPath = resolve(checkout, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error("editor_fixture_config_invalid");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, checkout, undefined, configPath);
if (parsed.errors.length) throw new Error("editor_fixture_config_cannot_be_resolved");

const entry = resolve(checkout, "src", "main.tsx");
const service = ts.createLanguageService({
	...ts.sys,
	getCurrentDirectory: () => checkout,
	getCompilationSettings: () => parsed.options,
	getScriptFileNames: () => parsed.fileNames,
	getScriptVersion: () => "0",
	getScriptSnapshot(file) {
		const content = ts.sys.readFile(file);
		return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
	},
	getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
});
const source = ts.sys.readFile(entry);
if (!source) throw new Error("editor_fixture_source_missing");
const definitions = Object.fromEntries(
	["React", "Scene", "OrbitControls"].map((symbol) => {
		const position = source.indexOf(symbol);
		const matches = service.getDefinitionAtPosition(entry, position + 1) ?? [];
		return [symbol, matches.some((target) => target.fileName.startsWith(shared + "/"))];
	}),
);
const errors = service.getSemanticDiagnostics(entry).map((diagnostic) => diagnostic.code);
console.log(JSON.stringify({ definitions, errors }));
if (!Object.values(definitions).every(Boolean) || errors.length) process.exitCode = 1;
