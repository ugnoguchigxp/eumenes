import { expect, test } from "vitest";
import { compileArtifact } from "@eumenes/artifact-ui";
import {
	recognitionDefinition,
	isRecognitionDefinition,
} from "./artifact-definition";
import type { ObjectRecognitionResource } from "@eumenes/artifact-ui/contracts";
const resource: ObjectRecognitionResource = {
	kind: "object-recognition-workspace",
	revision: 0,
	configured: true,
	items: [],
};
test("recognition JSON compiles alone and composed, with authenticated host source only", () => {
	const definition = recognitionDefinition();
	expect(isRecognitionDefinition(definition)).toBe(true);
	expect(
		compileArtifact(definition, { "object-recognition": resource }).request
			.view,
	).toBe("object-recognition-workspace");
	expect(
		compileArtifact(
			JSON.stringify({
				view: "layout",
				children: [
					JSON.parse(definition),
					{ view: "components", source: "help" },
				],
			}),
			{
				"object-recognition": resource,
				help: { kind: "components", revision: 0 },
			},
		).request.view,
	).toBe("layout");
	expect(() => compileArtifact(definition, {})).toThrow();
	expect(() =>
		compileArtifact(definition, {
			"object-recognition": { kind: "components", revision: 0 },
		}),
	).toThrow();
	expect(
		isRecognitionDefinition(
			JSON.stringify({ ...JSON.parse(definition), credential: "secret" }),
		),
	).toBe(false);
});
