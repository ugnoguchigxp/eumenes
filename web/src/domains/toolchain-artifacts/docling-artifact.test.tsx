import { expect, test } from "vitest";
import { compileArtifact } from "@eumenes/artifact-ui";
import bundle from "../../../../api/domains/capabilities/bundles/docling-desk.bundle.json" with { type: "json" };

test("launcher composes with text and information, while URL props and wrong sources are rejected", () => {
	const snapshot = {
		"docling-launcher": {
			kind: "external-app-launcher" as const,
			revision: 1,
			available: true,
			busy: false,
		},
	};
	const definition = bundle.artifacts.at(-1)!.variants[0]!.definition;
	expect(() =>
		compileArtifact(JSON.stringify(definition), snapshot),
	).not.toThrow();
	expect(() =>
		compileArtifact(
			JSON.stringify({
				view: "external-app-launcher",
				source: "docling-launcher",
				url: "https://other.invalid",
			}),
			snapshot,
		),
	).toThrow();
	expect(() => compileArtifact(JSON.stringify(definition), {})).toThrow();
});
