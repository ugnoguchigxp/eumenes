import { expect, test } from "bun:test";
import { createConfiguration, tokenDigest } from "../service/configuration";
import { fakeStore, memoryDb } from "./support";

const connection = (change: Record<string, unknown> = {}) => ({
	id: "conn",
	expectedRevision: 0,
	title: "接続",
	enabled: true,
	oauth: null,
	...change,
});
const oauth = {
	issuer: "https://issuer.example",
	jwksUrl: "https://issuer.example/jwks",
	resource: "https://resource.example",
	subject: "user-1",
};
const project = (change: Record<string, unknown> = {}) => ({
	ref: "project",
	connectionRef: "conn",
	expectedRevision: 0,
	title: "案件",
	nativeProjectId: "native",
	hostId: "local",
	environment: "local",
	enabled: true,
	...change,
});
function setup() {
	const db = memoryDb();
	const scopes: unknown[] = [];
	const config = createConfiguration(fakeStore(db), (_db, scope) =>
		scopes.push(scope),
	);
	return { db, config, scopes };
}

test("a new connection issues a local token once and authenticates by its digest", async () => {
	const { db, config, scopes } = setup();
	const created = await config.configure(connection());
	expect(created.localToken).toMatch(/^[0-9a-f]{64}$/);
	expect(created.connection).toEqual({
		id: "conn",
		title: "接続",
		enabled: true,
		oauth: null,
		revision: 1,
	});
	const stored = db
		.query("SELECT local_token_hash h, data_json d FROM dots_connections")
		.get() as { h: string; d: string };
	expect(stored.h).toBe(tokenDigest(created.localToken!));
	expect(stored.d).not.toContain(created.localToken!);
	expect(config.authenticateLocal(created.localToken!).id).toBe("conn");
	expect(() => config.authenticateLocal("0".repeat(64))).toThrow(
		"dots_permission_denied",
	);
	expect(scopes).toEqual([{ connectionRef: "conn", ownershipChanged: false }]);

	const updated = await config.configure(
		connection({ expectedRevision: 1, title: "改名", enabled: false }),
	);
	expect(updated.localToken).toBeNull();
	expect(updated.connection).toMatchObject({ title: "改名", revision: 2 });
	// The first token keeps working: an update never rotates it.
	expect(config.authenticateLocal(created.localToken!).title).toBe("改名");
});

test("a stale or invalid connection write is rejected", async () => {
	const { config } = setup();
	await expect(
		config.configure(connection({ expectedRevision: 3 })),
	).rejects.toThrow("dots_conflict");
	await config.configure(connection());
	await expect(config.configure(connection())).rejects.toThrow("dots_conflict");
	for (const bad of [
		{ id: "has space" },
		{ title: "  " },
		{ enabled: "yes" },
		{ extra: true },
		{ oauth: { ...oauth, issuer: "http://issuer.example" } },
		{ oauth: { ...oauth, jwksUrl: "https://issuer.example/jwks?x=1" } },
		{ oauth: { ...oauth, resource: "https://user:pw@resource.example" } },
	])
		await expect(
			config.configure(connection({ id: "other", ...bad })),
		).rejects.toThrow();
});

test("an oauth owner cannot be removed or replaced, and cannot be added after commands exist", async () => {
	const { db, config, scopes } = setup();
	await config.configure(connection({ id: "owned", oauth }));
	await expect(
		config.configure(
			connection({ id: "owned", expectedRevision: 1, oauth: null }),
		),
	).rejects.toThrow("dots_owner_immutable");
	await expect(
		config.configure(
			connection({
				id: "owned",
				expectedRevision: 1,
				oauth: { ...oauth, subject: "someone-else" },
			}),
		),
	).rejects.toThrow("dots_owner_immutable");
	await config.configure(
		connection({
			id: "owned",
			expectedRevision: 1,
			title: "同じ所有者",
			oauth,
		}),
	);

	await config.configure(connection({ id: "local" }));
	scopes.length = 0;
	const adopted = await config.configure(
		connection({ id: "local", expectedRevision: 1, oauth }),
	);
	expect(adopted.connection.oauth).toEqual(oauth);
	expect(scopes).toEqual([{ connectionRef: "local", ownershipChanged: true }]);

	await config.configure(connection({ id: "busy" }));
	db.query(
		"INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES('c','t','busy','pending','{}')",
	).run();
	await expect(
		config.configure(connection({ id: "busy", expectedRevision: 1, oauth })),
	).rejects.toThrow("dots_owner_immutable");
});

test("at most eight connections exist", async () => {
	const { config } = setup();
	for (let i = 0; i < 8; i++)
		await config.configure(connection({ id: `c${i}` }));
	await expect(config.configure(connection({ id: "c8" }))).rejects.toThrow(
		"dots_capacity",
	);
	// Existing connections can still be updated at capacity.
	await config.configure(
		connection({ id: "c0", expectedRevision: 1, title: "更新" }),
	);
});

test("projects need a connection, keep their owner and carry defaults", async () => {
	const { config, scopes } = setup();
	await expect(config.configureProject(project())).rejects.toThrow(
		"dots_not_found",
	);
	await config.configure(connection());
	await config.configure(connection({ id: "second" }));
	scopes.length = 0;
	const saved = await config.configureProject(project());
	expect(saved).toMatchObject({
		revision: 1,
		capabilityRevisionId: "package:dots.orchestrate@2",
		allowedOperations: ["read", "create_session", "edit", "check"],
	});
	expect(scopes).toEqual([{ projectRef: "project" }]);
	await expect(
		config.configureProject(
			project({ connectionRef: "second", expectedRevision: 1 }),
		),
	).rejects.toThrow("dots_conflict");
	await expect(config.configureProject(project())).rejects.toThrow(
		"dots_conflict",
	);
	const next = await config.configureProject(
		project({
			expectedRevision: 1,
			title: "改題",
			allowedOperations: ["read"],
		}),
	);
	expect(next).toMatchObject({ revision: 2, allowedOperations: ["read"] });
	for (const bad of [
		{ allowedOperations: [] },
		{ allowedOperations: ["deploy"] },
		{ capabilityRevisionId: "dots.orchestrate@2" },
		{ environment: "remote" },
	])
		await expect(
			config.configureProject(project({ ref: "other", ...bad })),
		).rejects.toThrow();
	expect(config.list()).toMatchObject({
		connections: [{ id: "conn" }, { id: "second" }],
		projects: [{ ref: "project", title: "改題" }],
	});
});

test("at most 64 projects exist", async () => {
	const { config } = setup();
	await config.configure(connection());
	for (let i = 0; i < 64; i++)
		await config.configureProject(project({ ref: `p${i}` }));
	await expect(
		config.configureProject(project({ ref: "p64" })),
	).rejects.toThrow("dots_capacity");
});

test("OAuth clientId is optional public setup metadata and does not change owner validation", async () => {
	const { db, config } = setup();
	const oauth = {
		issuer: "https://issuer.example",
		jwksUrl: "https://issuer.example/jwks",
		resource: "https://issuer.example/mcp/dots/conn",
		subject: "owner",
		clientId: "public-client",
	};
	const result = config.configureInTransaction(db, {
		id: "oauth-guide",
		expectedRevision: 0,
		title: "OAuth",
		enabled: true,
		oauth,
	});
	expect(result.connection.oauth?.clientId).toBe("public-client");
	expect(() =>
		config.configureInTransaction(db, {
			id: "oauth-guide",
			expectedRevision: 1,
			title: "OAuth",
			enabled: true,
			oauth: {
				...oauth,
				subject: "other",
				clientId: "different-public-client",
			},
		}),
	).toThrow("dots_owner_immutable");
});
