import { afterEach, expect, test } from "bun:test";
import { googleCloudTts } from "../contracts";
import { createSettings, isAllowedEnvRef } from "../service";
import { cleanup, credentialRows, setup } from "./settings.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("provisions the environment connection once on an existing settings document", async () => {
	const h = await setup();
	const before = h.settings.get();
	const options = {
		dbPath: h.dbPath,
		env: { [googleCloudTts.envRef]: "fixture-key" },
	};
	const settings = await createSettings(h.store, options);
	const provisioned = settings.get();
	const [connection] = provisioned.connections;
	expect(connection).toMatchObject({
		kind: googleCloudTts.kind,
		envRef: googleCloudTts.envRef,
		baseUrl: googleCloudTts.baseUrl,
	});
	expect(provisioned.routes).toEqual(before.routes);
	expect(provisioned.resources).toEqual(before.resources);
	expect(settings.credential(connection!)).toBe("fixture-key");
	expect(credentialRows(h)).toEqual([]);
	expect((await createSettings(h.store, options)).get()).toEqual(provisioned);
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: provisioned.revision,
		settings: { ...provisioned, connections: [] },
		keys: [],
	});
	expect((await createSettings(h.store, options)).get().connections).toEqual(
		[],
	);
});

test("binds the Google Cloud key to its API endpoint even with an allowlist entry", () => {
	const { envRef, baseUrl } = googleCloudTts;
	expect(isAllowedEnvRef(envRef, [], baseUrl)).toBe(true);
	expect(isAllowedEnvRef(envRef, [envRef], "https://example.test/v1")).toBe(
		false,
	);
});
