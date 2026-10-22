import { expect, test } from "bun:test";
import { defaults, type Settings } from "../../domains/settings";
import { applyStructures } from "./settings-structures";

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "22222222-2222-4222-8222-222222222222";

function saved(agencyResource: string | null): Settings {
	const doc = structuredClone(defaults({})) as Settings;
	doc.connections.push({ id: CONNECTION, enabled: true } as never);
	doc.resources.push(
		{
			id: RESOURCE,
			connectionId: CONNECTION,
			purpose: "llm",
			model: "m",
		} as never,
		{
			id: OTHER,
			connectionId: CONNECTION,
			purpose: "llm",
			model: "o",
		} as never,
	);
	doc.agency = {
		...doc.agency,
		enabled: true,
		resourceId: agencyResource,
	};
	return doc;
}

const deleteResource = (resourceId: string) => ({
	structure: "structure:settings.delete-resource@1",
	input: { resourceId },
});
const deleteConnection = (connectionId: string) => ({
	structure: "structure:settings.delete-connection@1",
	input: { connectionId },
});

test("deleting the model agency runs on switches agency off instead of falling back to LARM", () => {
	const { settings } = applyStructures(
		saved(RESOURCE),
		[deleteResource(RESOURCE)],
		[],
	);
	expect(settings.agency.resourceId).toBeNull();
	expect(settings.agency.enabled).toBe(false);
});

test("deleting its connection does the same, and unrelated deletions leave agency alone", () => {
	const gone = applyStructures(
		saved(RESOURCE),
		[deleteConnection(CONNECTION)],
		[],
	).settings;
	expect(gone.agency).toMatchObject({ resourceId: null, enabled: false });
	const kept = applyStructures(
		saved(RESOURCE),
		[deleteResource(OTHER)],
		[],
	).settings;
	expect(kept.agency).toMatchObject({ resourceId: RESOURCE, enabled: true });
	// Agency on the LARM local LLM (null) has nothing to release.
	const larm = applyStructures(
		saved(null),
		[deleteResource(OTHER)],
		[],
	).settings;
	expect(larm.agency).toMatchObject({ resourceId: null, enabled: true });
});
