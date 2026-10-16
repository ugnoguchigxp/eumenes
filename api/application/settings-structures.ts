import { z } from "zod";
import { prepareConnectionRegistration } from "../domains/settings/contracts/registration";
import {
	purposeSchema,
	type Purpose,
	type Settings,
} from "../domains/settings/contracts";

/**
 * Structural draft operations of the settings document (spec 2026-10-14 §10.1): the connection
 * and model lists change as a whole and the routes follow. Each is applied to the saved document
 * before the draft's field changes; the whole result is then checked by the settings schema and
 * the settings domain. Ids of added elements come from the host (UUIDs in the input).
 */
export const structureRefs = {
	addConnection: "structure:settings.add-connection@1",
	addWorkersConnection: "structure:settings.add-connection@2",
	deleteConnection: "structure:settings.delete-connection@1",
	addResource: "structure:settings.add-resource@1",
	addSpeechResource: "structure:settings.add-resource@2",
	deleteResource: "structure:settings.delete-resource@1",
	confirmLarmOrigin: "structure:settings.confirm-larm-origin@1",
} as const;
export const structureSchemaRefs: Record<string, string> = {
	[structureRefs.addConnection]: "schema:settings-add-connection@3",
	[structureRefs.addWorkersConnection]: "schema:settings-add-connection@4",
	[structureRefs.deleteConnection]: "schema:settings-delete-connection@1",
	[structureRefs.addResource]: "schema:settings-add-resource@1",
	[structureRefs.addSpeechResource]: "schema:settings-add-resource@2",
	[structureRefs.deleteResource]: "schema:settings-delete-resource@1",
	[structureRefs.confirmLarmOrigin]: "schema:settings-confirm-larm-origin@1",
};

const id = z.uuid();
const resource = {
	purpose: purposeSchema,
	model: z.string().min(1).max(200),
	contextWindow: z.number().int().optional(),
	voice: z.string().max(200).optional(),
	language: z.string().min(1).max(80).optional(),
	assign: z.boolean().optional(),
};
const deleteConnection = z.strictObject({ connectionId: id });
const addResource = z.strictObject({
	resourceId: id,
	connectionId: id,
	...resource,
});
const deleteResource = z.strictObject({ resourceId: id });
const confirmLarmOrigin = z.strictObject({
	origin: z.string().min(1).max(2048),
});

export type ApplyKey = { connectionId: string; value?: string; delete?: true };

/**
 * Routes that would lose their cloud fallback fall back to LARM, as the legacy screen did; the
 * dedicated World and sub-agent models of a removed model go back to the conversation route / LARM.
 */
function releaseFallbacks(doc: Settings, resourceIds: ReadonlySet<string>) {
	for (const purpose of purposeSchema.options) {
		const route = doc.routes[purpose];
		if (!route.fallbackId || !resourceIds.has(route.fallbackId)) continue;
		route.fallbackId = null;
		if (route.mode === "cloud-only") route.mode = "larm-preferred";
	}
	const curation = doc.world.curationResourceId;
	if (curation && resourceIds.has(curation))
		doc.world.curationResourceId = null;
	const subagent = doc.subagent.resourceId;
	if (subagent && resourceIds.has(subagent)) doc.subagent.resourceId = null;
}

export type StructuralResult = {
	settings: Settings;
	keys: ApplyKey[];
	confirmLarmOrigin?: string;
};

/** Applies the staged structural operations in order; every refusal is a safe error code. */
export function applyStructures(
	saved: Settings,
	structural: ReadonlyArray<{
		structure: string;
		input: Record<string, unknown>;
	}>,
	keysIn: readonly ApplyKey[],
): StructuralResult {
	const doc = structuredClone(saved);
	let keys = [...keysIn];
	let confirm: string | undefined;
	for (const { structure, input } of structural) {
		switch (structure) {
			case structureRefs.addConnection:
			case structureRefs.addWorkersConnection: {
				const registration = prepareConnectionRegistration(
					input,
					keys.some((k) => k.connectionId === input.connectionId && !!k.value),
				);
				if (!registration.ok) throw new Error(registration.code);
				const { input: v, connection } = registration;
				if (doc.connections.some((x) => x.id === v.connectionId))
					throw new Error("connection_exists");
				doc.connections.push(connection);
				if (v.purpose)
					addModel(doc, {
						resourceId: v.resourceId!,
						connectionId: v.connectionId,
						purpose: v.purpose,
						model: v.model!,
						contextWindow: v.contextWindow,
						voice: v.voice,
						language: v.language,
						assign: v.assign,
					});
				break;
			}
			case structureRefs.deleteConnection: {
				const c = deleteConnection.safeParse(input);
				if (!c.success) throw new Error("invalid_input");
				if (!doc.connections.some((x) => x.id === c.data.connectionId))
					throw new Error("target_not_found");
				releaseFallbacks(
					doc,
					new Set(
						doc.resources
							.filter((r) => r.connectionId === c.data.connectionId)
							.map((r) => r.id),
					),
				);
				doc.connections = doc.connections.filter(
					(x) => x.id !== c.data.connectionId,
				);
				doc.resources = doc.resources.filter(
					(r) => r.connectionId !== c.data.connectionId,
				);
				keys = keys.filter((k) => k.connectionId !== c.data.connectionId);
				break;
			}
			case structureRefs.addResource:
			case structureRefs.addSpeechResource: {
				const r = addResource.safeParse(input);
				if (!r.success) throw new Error("invalid_input");
				if (!doc.connections.some((x) => x.id === r.data.connectionId))
					throw new Error("target_not_found");
				addModel(doc, r.data);
				break;
			}
			case structureRefs.deleteResource: {
				const r = deleteResource.safeParse(input);
				if (!r.success) throw new Error("invalid_input");
				if (!doc.resources.some((x) => x.id === r.data.resourceId))
					throw new Error("target_not_found");
				releaseFallbacks(doc, new Set([r.data.resourceId]));
				doc.resources = doc.resources.filter((x) => x.id !== r.data.resourceId);
				break;
			}
			case structureRefs.confirmLarmOrigin: {
				const o = confirmLarmOrigin.safeParse(input);
				if (!o.success || confirm !== undefined)
					throw new Error("invalid_input");
				confirm = o.data.origin;
				break;
			}
			default:
				throw new Error("structure_not_registered");
		}
	}
	return {
		settings: doc,
		keys,
		...(confirm !== undefined ? { confirmLarmOrigin: confirm } : {}),
	};
}

function addModel(
	doc: Settings,
	v: {
		resourceId: string;
		connectionId: string;
		purpose: Purpose;
		model: string;
		contextWindow?: number;
		voice?: string;
		language?: string;
		assign?: boolean;
	},
) {
	if (doc.resources.some((x) => x.id === v.resourceId))
		throw new Error("resource_exists");
	doc.resources.push({
		id: v.resourceId,
		connectionId: v.connectionId,
		purpose: v.purpose,
		model: v.model,
		contextWindow: v.purpose === "llm" ? (v.contextWindow ?? 8192) : null,
		voice: v.purpose === "tts" ? (v.voice ?? "") : null,
		...(v.language ? { language: v.language } : {}),
	});
	// Only an unassigned purpose takes the new model as its fallback.
	if (v.assign && !doc.routes[v.purpose].fallbackId)
		doc.routes[v.purpose].fallbackId = v.resourceId;
}

/**
 * Linked route rules that belong to the document, not to a screen: turning cloud sending off
 * for a purpose that was cloud-only leaves LARM only.
 */
export function followRouteRules(before: Settings, doc: Settings) {
	for (const purpose of purposeSchema.options) {
		const route = doc.routes[purpose];
		if (
			before.routes[purpose].cloudAllowed &&
			!route.cloudAllowed &&
			route.mode === "cloud-only"
		)
			route.mode = "larm-only";
	}
}

/** A model whose purpose changed takes the purpose's own required values and frees its route. */
export function followPurposeChange(
	before: Settings,
	doc: Settings,
	resourceId: string,
) {
	const was = before.resources.find((r) => r.id === resourceId);
	const now = doc.resources.find((r) => r.id === resourceId);
	if (!was || !now || was.purpose === now.purpose) return;
	now.contextWindow = now.purpose === "llm" ? 8192 : null;
	now.voice = now.purpose === "tts" ? "" : null;
	const route = doc.routes[was.purpose];
	if (route.fallbackId === resourceId) {
		route.fallbackId = null;
		if (route.mode === "cloud-only") route.mode = "larm-preferred";
	}
}

// ---- target lists ---------------------------------------------------------------------------

type Credential = { id: string; credentialAvailable: boolean };
const modelLabel = (doc: Settings, r: Settings["resources"][number]) =>
	`${doc.connections.find((c) => c.id === r.connectionId)?.name ?? "登録モデル"} / ${r.model}`;

/** Connections as targets: names and states only, never a credential. */
export function connectionTargets(
	doc: Settings,
	credentials: readonly Credential[],
) {
	return doc.connections.map((c) => {
		const registered = credentials.some(
			(x) => x.id === c.id && x.credentialAvailable,
		);
		return {
			id: c.id,
			label: c.name,
			kind: c.kind ?? "openai-compatible",
			...(c.auth ? { auth: c.auth } : {}),
			enabled: c.enabled,
			credential: c.envRef
				? "environment"
				: registered
					? "registered"
					: c.kind === "codex-sdk"
						? "login"
						: "none",
		};
	});
}

/** Models as targets, optionally of one purpose. */
export function resourceTargets(doc: Settings, purpose?: Purpose) {
	return doc.resources
		.filter((r) => !purpose || r.purpose === purpose)
		.map((r) => {
			const assigned = doc.routes[r.purpose].fallbackId === r.id;
			const label = modelLabel(doc, r);
			return {
				id: r.id,
				label,
				selectLabel: `${label}${assigned ? "（割当済み）" : "（未割当）"}`,
				connectionId: r.connectionId,
				connection:
					doc.connections.find((c) => c.id === r.connectionId)?.name ??
					"登録モデル",
				purpose: r.purpose,
				model: r.model,
				assigned,
			};
		});
}

/** Each purpose's route with its fallback named. */
export function routeSummaries(doc: Settings) {
	return Object.fromEntries(
		purposeSchema.options.map((purpose) => {
			const route = doc.routes[purpose];
			const fallback = doc.resources.find((r) => r.id === route.fallbackId);
			return [
				purpose,
				{
					mode: route.mode,
					cloudAllowed: route.cloudAllowed,
					fallbackId: route.fallbackId,
					fallbackLabel: fallback ? modelLabel(doc, fallback) : null,
					resourceCount: doc.resources.filter((r) => r.purpose === purpose)
						.length,
				},
			];
		}),
	);
}
