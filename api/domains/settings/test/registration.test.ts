import { expect, test } from "bun:test";
import { prepareConnectionRegistration } from "../contracts";

const workers = () => ({
	connectionId: crypto.randomUUID(),
	kind: "cloudflare-workers-ai",
	name: "Workers接続",
	accountId: "a".repeat(32),
});

test("registration rejects malformed accounts and missing credentials before a draft can be accepted", () => {
	for (const accountId of ["short", "z".repeat(32), undefined])
		expect(
			prepareConnectionRegistration({ ...workers(), accountId }, true),
		).toMatchObject({ ok: false, field: "accountId" });
	expect(prepareConnectionRegistration(workers(), false)).toMatchObject({
		ok: false,
		code: "credential_required",
		field: "apiKey",
	});
	expect(prepareConnectionRegistration(workers(), true)).toMatchObject({
		ok: true,
		connection: {
			baseUrl: "https://api.cloudflare.com/client/v4",
			accountId: "a".repeat(32),
		},
	});
});

test("the shared registration contract retains credential-source, URL and optional-model rules for other connections", () => {
	const base = {
		connectionId: crypto.randomUUID(),
		name: "Another connection",
		baseUrl: "https://example.test/v1",
	};
	expect(prepareConnectionRegistration(base, true).ok).toBe(true);
	expect(
		prepareConnectionRegistration(
			{ ...base, envRef: "EUMENES_CLOUD_KEY" },
			false,
		).ok,
	).toBe(true);
	expect(
		prepareConnectionRegistration(
			{ ...base, envRef: "EUMENES_CLOUD_KEY" },
			true,
		),
	).toMatchObject({ ok: false, code: "invalid_credential_source" });
	expect(
		prepareConnectionRegistration({ ...base, kind: "codex-sdk" }, false).ok,
	).toBe(true);
	expect(
		prepareConnectionRegistration(
			{ ...base, baseUrl: "http://external.test/v1" },
			true,
		),
	).toMatchObject({ ok: false, field: "baseUrl" });
	expect(
		prepareConnectionRegistration({ ...base, model: "incomplete" }, false),
	).toMatchObject({ ok: false, code: "invalid_input", field: "purpose" });
	expect(
		prepareConnectionRegistration({ ...base, name: "   " }, true),
	).toMatchObject({ ok: false, field: "name" });
});
