import { expect, test } from "bun:test";
import { resolveApiToken, resolveLarmToken } from "./auth-config";

test("LARM_API_TOKEN alone supplies distinct, consistent local API auth", () => {
	const env = { LARM_API_TOKEN: "fixture-control" };
	expect(resolveLarmToken(env)).toBe("fixture-control");
	const local = resolveApiToken(env);
	expect(local).not.toBe(env.LARM_API_TOKEN);
	expect(local).toMatch(/^[a-f0-9]{64}$/);
	expect(resolveApiToken({ ...env })).toBe(local);
	expect(resolveApiToken({ LARM_API_TOKEN: "different-control" })).not.toBe(
		local,
	);
});

test("empty optional settings do not mask the exported LARM token", () => {
	const env = {
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
		EUMENES_API_TOKEN: "",
	};
	expect(resolveLarmToken(env)).toBe("fixture-control");
	expect(resolveApiToken(env)).toBe(
		resolveApiToken({ LARM_API_TOKEN: "fixture-control" }),
	);
	expect(resolveLarmToken({ ...env, LARM_CONTROL_TOKEN: "old-control" })).toBe(
		"fixture-control",
	);
});

test("explicit API credentials and legacy LARM settings remain supported", () => {
	const explicit = "local-api-token-with-24-characters";
	expect(
		resolveApiToken({ EUMENES_API_TOKEN: explicit, LARM_API_TOKEN: "control" }),
	).toBe(explicit);
	expect(resolveApiToken({ LARM_CONTROL_TOKEN: "legacy" })).toBe(
		resolveApiToken({ LARM_API_TOKEN: "legacy" }),
	);
	expect(() =>
		resolveApiToken({ EUMENES_API_TOKEN: "short", LARM_API_TOKEN: "control" }),
	).toThrow("at least 24");
	expect(() => resolveApiToken({})).toThrow("Set LARM_API_TOKEN");
});
