import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import type { Capabilities } from "../domains/capabilities";
import {
	ref,
	type Connection,
	type Project,
	type createConfiguration,
	type createEvents,
} from "../domains/dots";
import type { AdapterResult, DomainAdapter } from "../domains/tool-runtime";

export const DOTS_ADAPTER_REF = "adapter:dots@1";
const CONNECTIONS = "query:dots.connections@1";
const PROJECTS = "query:dots.projects@1";
const PACKAGES = "query:dots.packages@1";
const CONNECTION_OPTIONS = "query:dots.connection-options@1";
const CAPABILITY_OPTIONS = "query:dots.capability-options@1";
/** The package a project uses when none is chosen (the domain's own default). */
const STANDARD_CAPABILITY = "package:dots.orchestrate@2";

type Pack = ReturnType<
	Capabilities["listDotsPackagesInTransaction"]
>["items"][number];

/** What the dots adapter reads and changes; each is a domain's public transaction operation. */
export type DotsAdapterPorts = {
	config: Pick<
		ReturnType<typeof createConfiguration>,
		| "listInTransaction"
		| "configureInTransaction"
		| "configureProjectInTransaction"
	>;
	events: Pick<ReturnType<typeof createEvents>, "statusInTransaction">;
	packages: Pick<
		Capabilities,
		"listDotsPackagesInTransaction" | "putDotsPackageInTransaction"
	>;
};

// ---- operation inputs ----------------------------------------------------------------------
// Forms send flat values (empty fields are absent, toggles are booleans); the adapter builds
// the domain's own input and the domain's schema judges it. A create has no id: the adapter
// derives it from the request id. An update carries the guard the screen read from its row
// (`expectedRevision`, or `expectedToken` for packages), which is passed to the domain as is.

const text = (max: number) => z.string().max(max).optional();
const revision = z.number().int().min(0);
const toggle = z.boolean().optional();
const connectionFields = {
	title: z.string().max(120),
	enabled: z.boolean(),
	oauthIssuer: text(2048),
	oauthJwksUrl: text(2048),
	oauthResource: text(2048),
	oauthSubject: text(200),
};
const connectionCreate = z.strictObject(connectionFields);
const connectionUpdate = z.strictObject({
	id: ref,
	expectedRevision: revision,
	...connectionFields,
});
const connectionEnabled = z.strictObject({
	id: ref,
	expectedRevision: revision,
	enabled: z.boolean(),
});
const OPERATION_KEYS = [
	["read", "opRead"],
	["create_session", "opCreateSession"],
	["continue_session", "opContinueSession"],
	["edit", "opEdit"],
	["check", "opCheck"],
	["commit", "opCommit"],
	["push", "opPush"],
	["publish", "opPublish"],
	["send", "opSend"],
] as const;
const projectFields = {
	title: z.string().max(120),
	capabilityRevisionId: text(200),
	nativeProjectId: z.string().max(160),
	hostId: z.string().max(160),
	environment: z.enum(["local", "cloud"]),
	enabled: z.boolean(),
	opRead: toggle,
	opCreateSession: toggle,
	opContinueSession: toggle,
	opEdit: toggle,
	opCheck: toggle,
	opCommit: toggle,
	opPush: toggle,
	opPublish: toggle,
	opSend: toggle,
};
const projectCreate = z.strictObject({ connectionRef: ref, ...projectFields });
/** The connection of a project never changes, so an update does not carry it. */
const projectUpdate = z.strictObject({
	ref,
	expectedRevision: revision,
	...projectFields,
});
const projectEnabled = z.strictObject({
	ref,
	expectedRevision: revision,
	enabled: z.boolean(),
});
const SKILLS = [1, 2, 3, 4] as const;
const packageFields = {
	title: z.string().max(120),
	summary: z.string().max(600),
	profile: z.string().max(8000),
	enabled: z.boolean(),
	skill1Title: z.string().max(120),
	skill1Body: z.string().max(8000),
	skill2Title: text(120),
	skill2Body: text(8000),
	skill3Title: text(120),
	skill3Body: text(8000),
	skill4Title: text(120),
	skill4Body: text(8000),
};
const packageCreate = z.strictObject(packageFields);
const packageUpdate = z.strictObject({
	id: z.string().max(80),
	expectedToken: z.string().min(1).max(200),
	...packageFields,
});
const packageEnabled = z.strictObject({
	id: z.string().max(80),
	expectedToken: z.string().min(1).max(200),
	enabled: z.boolean(),
});

const sha256 = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filled = (value: string | undefined) => value?.trim() || undefined;
const OPERATION_LABELS: Record<string, string> = {
	read: "参照",
	create_session: "新しいSession",
	continue_session: "既存Sessionの続行",
	edit: "編集",
	check: "検証",
	commit: "コミット",
	push: "プッシュ",
	publish: "公開",
	send: "外部への送信",
};

/** What the dots adapter offers, without domain services (bundle checks, evaluation). */
export const describeDotsAdapter = () => ({
	owner: "dots",
	operations: new Map(
		(
			[
				["dots.connection-create", "schema:dots-connection-create@1"],
				["dots.connection-update", "schema:dots-connection-update@1"],
				["dots.connection-enabled", "schema:dots-connection-enabled@1"],
				["dots.project-create", "schema:dots-project-create@1"],
				["dots.project-update", "schema:dots-project-update@1"],
				["dots.project-enabled", "schema:dots-project-enabled@1"],
				["dots.package-create", "schema:dots-package-create@1"],
				["dots.package-update", "schema:dots-package-update@1"],
				["dots.package-enabled", "schema:dots-package-enabled@1"],
			] as const
		).map(([name, inputSchemaRef]) => [
			name,
			{ inputSchemaRef, effect: "write" as const },
		]),
	),
	queries: new Set([
		CONNECTIONS,
		PROJECTS,
		PACKAGES,
		CONNECTION_OPTIONS,
		CAPABILITY_OPTIONS,
	]),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:dots@1",
});

/**
 * Run a domain call. A schema refusal inside it is an invalid input, and the domains' stale
 * revision or token refusals are the screen's `revision_conflict`; neither is a server error.
 */
function guarded<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof ZodError) throw new Error("invalid_input");
		if (
			error instanceof Error &&
			(error.message === "dots_conflict" ||
				error.message === "capability_revision_conflict")
		)
			throw new Error("revision_conflict");
		throw error;
	}
}
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new Error("invalid_input");
	return parsed.data;
};

/** The OAuth settings of a form: all four values, or none for a local-only connection. */
function oauthOf(input: z.infer<typeof connectionCreate>): Connection["oauth"] {
	const [issuer, jwksUrl, resource, subject] = [
		input.oauthIssuer,
		input.oauthJwksUrl,
		input.oauthResource,
		input.oauthSubject,
	].map(filled);
	if (!issuer && !jwksUrl && !resource && !subject) return null;
	if (!issuer || !jwksUrl || !resource || !subject)
		throw new Error("invalid_input");
	return { issuer, jwksUrl, resource, subject };
}

const projectBody = (project: Project) => {
	const { revision: _revision, ...fields } = project;
	return fields;
};

/** The sources: rows shaped for the collection and for the edit forms they prefill. */
function sources(ports: DotsAdapterPorts, tx: Database, query: string) {
	const { connections, projects } = ports.config.listInTransaction(tx);
	const packages = ports.packages.listDotsPackagesInTransaction(tx).items;
	const titles = new Map(connections.map((c) => [c.id, c.title]));
	const sum = (revisions: number[]) => revisions.reduce((a, b) => a + b, 0);
	const options = (list: Array<{ value: string; label: string }>) => ({
		revision: 0,
		data: { options: list },
	});
	switch (query) {
		case CONNECTIONS:
			return {
				revision: sum(connections.map((c) => c.revision)),
				data: connections.map((c) => ({
					id: c.id,
					title: c.title,
					revision: c.revision,
					enabled: c.enabled,
					mode: c.oauth ? "OAuth" : "ローカル専用",
					oauthIssuer: c.oauth?.issuer ?? "",
					oauthJwksUrl: c.oauth?.jwksUrl ?? "",
					oauthResource: c.oauth?.resource ?? "",
					oauthSubject: c.oauth?.subject ?? "",
					endpoint: `/mcp/dots/${c.id}`,
					subscription: ports.events.statusInTransaction(tx, c.id).subscribed
						? "有効"
						: "未登録または期限切れ",
				})),
			};
		case PROJECTS:
			return {
				revision: sum(projects.map((p) => p.revision)),
				data: projects.map((p) => ({
					ref: p.ref,
					title: p.title,
					revision: p.revision,
					enabled: p.enabled,
					connection: titles.get(p.connectionRef) ?? p.connectionRef,
					environment: p.environment,
					environmentLabel: p.environment === "cloud" ? "クラウド" : "ローカル",
					nativeProjectId: p.nativeProjectId,
					hostId: p.hostId,
					operations: p.allowedOperations
						.map((op) => OPERATION_LABELS[op] ?? op)
						.join("・"),
					capabilityRevisionId: p.capabilityRevisionId,
					capability: capabilityLabel(p.capabilityRevisionId, packages),
					...Object.fromEntries(
						OPERATION_KEYS.map(([op, key]) => [
							key,
							p.allowedOperations.includes(op),
						]),
					),
				})),
			};
		case PACKAGES:
			return {
				revision: 0,
				data: packages.map((p) => ({
					id: p.id,
					title: p.title,
					summary: p.summary,
					profile: p.profile,
					revision: p.revision,
					enabled: p.enabled,
					skillCount: p.skills.length,
					stateToken: p.stateToken,
					...Object.fromEntries(
						SKILLS.flatMap((n) => [
							[`skill${n}Title`, p.skills[n - 1]?.title ?? ""],
							[`skill${n}Body`, p.skills[n - 1]?.body ?? ""],
						]),
					),
				})),
			};
		case CONNECTION_OPTIONS:
			return options(connections.map((c) => ({ value: c.id, label: c.title })));
		case CAPABILITY_OPTIONS:
			return options([
				{ value: STANDARD_CAPABILITY, label: "標準の調整担当" },
				...packages
					.filter((p) => p.enabled)
					.map((p) => ({
						value: p.revisionId,
						label: `${p.title}（版 ${p.revision}）`,
					})),
			]);
		default:
			return null;
	}
}

function capabilityLabel(revisionId: string, packages: Pack[]) {
	if (revisionId === STANDARD_CAPABILITY) return "標準の調整担当";
	const found = packages.find((p) => p.revisionId === revisionId);
	return found
		? `${found.title}（版 ${found.revision}）`
		: `${revisionId}（現在は選べません）`;
}

const connectionOf = (ports: DotsAdapterPorts, tx: Database, id: string) => {
	const found = ports.config
		.listInTransaction(tx)
		.connections.find((c) => c.id === id);
	if (!found) throw new Error("dots_not_found");
	return found;
};
const projectOf = (
	ports: DotsAdapterPorts,
	tx: Database,
	projectRef: string,
) => {
	const found = ports.config
		.listInTransaction(tx)
		.projects.find((p) => p.ref === projectRef);
	if (!found) throw new Error("dots_not_found");
	return found;
};
const packageOf = (ports: DotsAdapterPorts, tx: Database, id: string) => {
	const found = ports.packages
		.listDotsPackagesInTransaction(tx)
		.items.find((p) => p.id === id);
	if (!found) throw new Error("dots_not_found");
	return found;
};
const connectionBody = (input: z.infer<typeof connectionCreate>) => ({
	title: input.title,
	enabled: input.enabled,
	oauth: oauthOf(input),
});
const projectBodyOf = (
	input: z.infer<typeof projectUpdate>,
	connectionRef: string,
) => ({
	connectionRef,
	title: input.title,
	...(filled(input.capabilityRevisionId)
		? { capabilityRevisionId: filled(input.capabilityRevisionId) }
		: {}),
	allowedOperations: OPERATION_KEYS.filter(
		([, key]) => input[key] === true,
	).map(([op]) => op),
	nativeProjectId: input.nativeProjectId,
	hostId: input.hostId,
	environment: input.environment,
	enabled: input.enabled,
});
function packageBody(input: z.infer<typeof packageCreate>) {
	const skills = SKILLS.flatMap((n) => {
		const title = filled(input[`skill${n}Title`]);
		const body = filled(input[`skill${n}Body`]);
		if (!title && !body) return [];
		if (!title || !body) throw new Error("invalid_input");
		return [{ title, body }];
	});
	return {
		title: input.title,
		summary: input.summary,
		profile: input.profile,
		skills,
		enabled: input.enabled,
	};
}

/**
 * The typed dots adapter: connections (with the one-time local token), projects and user
 * packages. The dots and capabilities domains keep every rule — revisions, tokens, owners,
 * capacity; this adapter only builds their inputs from form values and rows. Settings screens
 * are UI only: a conversation never configures dots through it.
 *
 * The receipt of an accepted operation is handed to the ledger's first read of the result
 * (`readInTransaction`) and then dropped; the domain stores none. Only the receipt of a newly
 * created connection carries its plaintext local token, so the token reaches the screen once, in
 * that action's settled result. Neither the ledger, a source nor a later read ever has it.
 */
export function createDotsAdapter(
	ports: DotsAdapterPorts,
	options: { now?: () => number } = {},
): DomainAdapter {
	const now = options.now ?? Date.now;
	const held = new Map<
		string,
		{ receipt: Record<string, unknown>; digest: string; expires: number }
	>();
	function done(
		receipt: Record<string, unknown>,
		requestId: string,
		resultRef: { kind: string; id: string; revision?: number },
		oneTime?: Record<string, unknown>,
	): AdapterResult {
		const digest = sha256(receipt);
		for (const [id, entry] of held) if (entry.expires <= now()) held.delete(id);
		while (held.size >= 8) held.delete(held.keys().next().value!);
		held.set(requestId, {
			receipt: { ...receipt, ...oneTime },
			digest,
			expires: now() + 60_000,
		});
		return {
			receipt,
			receiptRef: { owner: "dots", operationId: requestId, digest },
			resultRefs: [
				{
					owner: "dots",
					schemaRef: `domain:dots.${resultRef.kind}@1`,
					...resultRef,
				},
			],
			replay: false,
		};
	}
	function connectionResult(
		saved: ReturnType<DotsAdapterPorts["config"]["configureInTransaction"]>,
		requestId: string,
	) {
		const { connection, localToken } = saved;
		const receipt = {
			version: 1,
			kind: "connection",
			id: connection.id,
			revision: connection.revision,
			created: localToken !== null,
		};
		return done(
			receipt,
			requestId,
			{ kind: "connection", id: connection.id, revision: connection.revision },
			localToken === null ? undefined : { localToken },
		);
	}
	function projectResult(
		project: ReturnType<
			DotsAdapterPorts["config"]["configureProjectInTransaction"]
		>,
		requestId: string,
	) {
		return done(
			{
				version: 1,
				kind: "project",
				ref: project.ref,
				revision: project.revision,
			},
			requestId,
			{ kind: "project", id: project.ref, revision: project.revision },
		);
	}
	function packageResult(saved: Pack, requestId: string) {
		return done(
			{
				version: 1,
				kind: "package",
				id: saved.id,
				revision: saved.revision,
				revisionId: saved.revisionId,
			},
			requestId,
			{ kind: "package", id: saved.id, revision: saved.revision },
		);
	}
	function invoke(tx: Database, operation: string, input: unknown, id: string) {
		switch (operation) {
			case "dots.connection-create": {
				const body = connectionBody(parse(connectionCreate, input));
				return connectionResult(
					guarded(() =>
						ports.config.configureInTransaction(tx, {
							id,
							expectedRevision: 0,
							...body,
						}),
					),
					id,
				);
			}
			case "dots.connection-update": {
				const data = parse(connectionUpdate, input);
				const current = connectionOf(ports, tx, data.id);
				return connectionResult(
					guarded(() =>
						ports.config.configureInTransaction(tx, {
							id: current.id,
							expectedRevision: data.expectedRevision,
							...connectionBody(data),
						}),
					),
					id,
				);
			}
			case "dots.connection-enabled": {
				const data = parse(connectionEnabled, input);
				const current = connectionOf(ports, tx, data.id);
				return connectionResult(
					guarded(() =>
						ports.config.configureInTransaction(tx, {
							id: current.id,
							expectedRevision: data.expectedRevision,
							title: current.title,
							enabled: data.enabled,
							oauth: current.oauth,
						}),
					),
					id,
				);
			}
			case "dots.project-create": {
				const data = parse(projectCreate, input);
				return projectResult(
					guarded(() =>
						ports.config.configureProjectInTransaction(tx, {
							ref: id,
							expectedRevision: 0,
							...projectBodyOf(
								{ ...data, ref: id, expectedRevision: 0 },
								data.connectionRef,
							),
						}),
					),
					id,
				);
			}
			case "dots.project-update": {
				const data = parse(projectUpdate, input);
				const current = projectOf(ports, tx, data.ref);
				return projectResult(
					guarded(() =>
						ports.config.configureProjectInTransaction(tx, {
							ref: current.ref,
							expectedRevision: data.expectedRevision,
							...projectBodyOf(data, current.connectionRef),
						}),
					),
					id,
				);
			}
			case "dots.project-enabled": {
				const data = parse(projectEnabled, input);
				const current = projectOf(ports, tx, data.ref);
				return projectResult(
					guarded(() =>
						ports.config.configureProjectInTransaction(tx, {
							...projectBody(current),
							expectedRevision: data.expectedRevision,
							enabled: data.enabled,
						}),
					),
					id,
				);
			}
			case "dots.package-create": {
				const body = packageBody(parse(packageCreate, input));
				return packageResult(
					guarded(() =>
						ports.packages.putDotsPackageInTransaction(tx, {
							id: `dots.user.${id.replaceAll("-", "")}`,
							expectedToken: null,
							...body,
						}),
					),
					id,
				);
			}
			case "dots.package-update": {
				const data = parse(packageUpdate, input);
				const current = packageOf(ports, tx, data.id);
				return packageResult(
					guarded(() =>
						ports.packages.putDotsPackageInTransaction(tx, {
							id: current.id,
							expectedToken: data.expectedToken,
							...packageBody(data),
						}),
					),
					id,
				);
			}
			case "dots.package-enabled": {
				const data = parse(packageEnabled, input);
				const current = packageOf(ports, tx, data.id);
				return packageResult(
					guarded(() =>
						ports.packages.putDotsPackageInTransaction(tx, {
							id: current.id,
							expectedToken: data.expectedToken,
							title: current.title,
							summary: current.summary,
							profile: current.profile,
							skills: current.skills,
							enabled: data.enabled,
						}),
					),
					id,
				);
			}
			default:
				throw new Error("capability_unavailable");
		}
	}
	return {
		ref: DOTS_ADAPTER_REF,
		describe: describeDotsAdapter,
		// Setting dots up must work before any connection is enabled; the host registers this
		// adapter only when dots is turned on at all.
		availableInTransaction: () => true,
		snapshotInTransaction: () => ({ items: [] }),
		invokeInTransaction(tx, request): AdapterResult {
			if (request.origin.kind !== "ui")
				throw new Error("capability_unavailable");
			return invoke(
				tx,
				request.operationName,
				request.input,
				request.requestId,
			);
		},
		// Only the creating action's own settled result carries the one-time token, and only once.
		readInTransaction(_tx, operationId) {
			const entry = held.get(operationId);
			held.delete(operationId);
			if (!entry || entry.expires <= now()) return null;
			return {
				receipt: entry.receipt,
				receiptRef: { owner: "dots", operationId, digest: entry.digest },
				resultRefs: [],
				replay: false,
			};
		},
		sourceInTransaction: (tx, query) => sources(ports, tx, query),
		targetInput: () => ({}),
	};
}
