import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	findSiteObjects,
	listPageProfiles,
	upsertSiteScope,
	upsertPageProfile,
	writeSiteObject,
	getSearchUrl,
} from "eumenes-interact/sqlite";
import { partsHelpers } from "eumenes-interact/parts";
import type { SqliteStore } from "../../../infrastructure/sqlite";

const fields = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean()]),
);
const candidate = z.object({
	kind: z.enum(["role", "structure"]),
	fields,
	source: z.object({ adapter: z.literal("playwright-mcp"), via: z.string() }),
});
const site = z.object({
	sourceRef: z.string(),
	sourceSha256: z.string(),
	origins: z.array(z.url()),
	pageProfiles: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			urlHint: z.string(),
		}),
	),
	objects: z.array(
		z.object({
			profile: z.string(),
			logicalName: z.string(),
			description: z.string(),
			candidates: z.array(candidate),
		}),
	),
});
const seed = z.object({
	sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
	lastConfirmedAt: z.null(),
	sites: z.array(site),
});
/** Imported public locator data stays a candidate. Import time is never presented as a successful live check. */
export function seedInteractSites(
	db: Database,
	owner: string,
	raw: unknown,
	nowIso: string,
) {
	const data = seed.parse(raw);
	for (const site of data.sites)
		for (const origin of site.origins) {
			upsertSiteScope(db, owner, origin, nowIso);
			for (const p of site.pageProfiles)
				upsertPageProfile(
					db,
					owner,
					origin,
					{
						...p,
						conditions: {
							sourceRef: site.sourceRef,
							sourceRevision: data.sourceCommit,
							sourceSha256: site.sourceSha256,
						},
						basis: "unverified imported candidate; lastConfirmedAt unknown",
					},
					nowIso,
				);
			for (const o of site.objects) {
				if (
					findSiteObjects(db, owner, {
						origin,
						profile: o.profile,
						logicalName: o.logicalName,
						includeDisabled: true,
					}).length
				)
					continue;
				writeSiteObject(db, owner, {
					origin,
					profile: o.profile,
					logicalName: o.logicalName,
					description: o.description,
					candidates: o.candidates,
					expectedRevision: 0,
					nowIso,
				});
			}
		}
}
/** Resolve only a supported locator contract against the fresh snapshot; ambiguous/unsupported candidates fall back to the public part's observation path. */
export function interactKnowledge(
	store: SqliteStore,
	owner: string,
	now: () => number,
) {
	return {
		searchUrl: (url: string, query: string) =>
			store.read((db) =>
				getSearchUrl(db, owner, url, query, new Date(now()).toISOString()),
			),
		resolve(url: string, body: string, logicalName: string) {
			return store.read((db) => {
				const page = new URL(url);
				const profiles = listPageProfiles(db, owner, page.origin).filter((p) =>
					page.pathname.startsWith(p.urlHint ?? "/"),
				);
				const hits = new Map<
					string,
					{ ref: string; role: string; name: string }
				>();
				for (const p of profiles)
					for (const obj of findSiteObjects(db, owner, {
						origin: page.origin,
						profile: p.name,
						logicalName,
					}))
						for (const c of obj.candidates) {
							if (
								!["candidate", "verified"].includes(c.status) ||
								c.source.adapter !== "playwright-mcp" ||
								c.kind !== "role" ||
								Object.keys(c.fields).some((k) => k !== "role" && k !== "name")
							)
								continue;
							const role = c.fields.role,
								name = c.fields.name;
							if (typeof role !== "string" || typeof name !== "string")
								continue;
							const matches = partsHelpers
								.findItems(body, "p0", { role, text: null }, 100)
								.filter(
									(r) => r.role === role && r.name === name && r.count === 1,
								);
							if (matches.length === 1) {
								const m = matches[0]!;
								hits.set(m.ref, { ref: m.ref, role, name });
							}
						}
				return hits.size === 1 ? [...hits.values()][0]! : null;
			});
		},
	};
}
