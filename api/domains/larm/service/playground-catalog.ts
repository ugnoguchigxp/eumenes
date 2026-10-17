import { createHash } from "node:crypto";
import { z } from "zod";
import type { LarmTestTarget, TestKind } from "../contracts/playground";
import { code, json, list, object, str } from "./playground-http";

type Control = (
	path: string,
	signal: AbortSignal,
	init?: RequestInit,
	accepted?: number[],
) => Promise<Response>;
// The public selector constraint is published by LARM's OpenAPI query parameter.
const selectors = z
	.array(
		z
			.string()
			.min(1)
			.max(128)
			.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
	)
	.max(512);
async function publicSelectors(control: Control, signal: AbortSignal) {
	const response = await control("/openapi.json", signal, {}, [200, 404]);
	if (response.status === 404) {
		await response.body?.cancel();
		return [];
	}
	const spec = await json(response);
	const operation = object(
		object(object(spec.paths)["/v3/agent-profiles"]).get,
	);
	const parameter = list(operation.parameters).find(
		(p) => p.name === "profile" && p.in === "query",
	);
	return selectors.parse(
		parameter ? (object(parameter.schema).enum ?? []) : [],
	);
}

/** Discover services by public selectors as well as the catalog's concrete profile IDs. */
export function createPlaygroundCatalog({
	control,
	publicUrl,
	origin,
	profile,
	kinds,
	paths,
}: {
	control: Control;
	publicUrl: (path: string) => URL;
	origin: string;
	profile?: string;
	kinds: Record<string, TestKind>;
	paths: Record<string, string>;
}) {
	return async (signal: AbortSignal) => {
		const targets = new Map<string, LarmTestTarget>();
		const errors: string[] = [];
		let revision: string | undefined;
		async function fetchProfiles(selector: string) {
			const data = await json(
				await control(
					`/v3/agent-profiles${selector ? `?profile=${encodeURIComponent(selector)}` : ""}`,
					signal,
				),
			);
			if (
				data.contractVersion !== "agent-connection.v3" ||
				(selector && data.requestedProfile !== selector)
			)
				throw new Error("invalid_catalog");
			const rev = str(data.catalogRevision);
			if (revision && revision !== rev) throw new Error("stale_catalog");
			revision = rev;
			return { rev, profiles: list(data.profiles) };
		}
		function ingest(
			selector: string,
			rev: string,
			profiles: ReturnType<typeof list>,
			modes: readonly ("provider" | "service")[],
		) {
			for (const p of profiles)
				for (const mode of modes)
					for (const item of list(
						p[mode === "provider" ? "providers" : "services"] ?? [],
					)) {
						const protocol = str(item.protocol),
							endpoint = str(item.endpoint),
							model = str(item.model),
							name = str(item.name),
							profile = str(p.id);
						const kind = kinds[protocol] ?? "unsupported";
						const id = createHash("sha256")
							.update(
								JSON.stringify([
									origin,
									mode,
									profile,
									name,
									protocol,
									model,
									endpoint,
								]),
							)
							.digest("hex")
							.slice(0, 32);
						const previous = targets.get(id);
						targets.set(id, {
							id,
							name,
							description:
								typeof item.description === "string"
									? item.description
									: undefined,
							model,
							capability: str(item.capability),
							protocol,
							kind: paths[kind] === endpoint ? kind : "unsupported",
							mode,
							endpoint:
								mode === "service"
									? publicUrl(str(item.url ?? endpoint)).pathname
									: endpoint,
							profile,
							selector: previous?.selector ?? (selector || undefined),
							revision: rev,
							onDemand:
								mode === "service" &&
								object(item.startupPolicy ?? {}).minWarmInstances === 0,
							primary: previous?.primary || !!selector,
						});
					}
		}
		for (const selector of new Set([profile?.trim() ?? "", ""])) {
			try {
				const { rev, profiles } = await fetchProfiles(selector);
				ingest(selector, rev, profiles, ["provider", "service"]);
				if (selector) continue;
				for (const p of profiles) {
					if (list(p.services ?? []).length) continue;
					const id = str(p.id);
					try {
						const again = await fetchProfiles(id);
						ingest(id, again.rev, again.profiles, ["service"]);
					} catch (e) {
						if (code(e) === "stale_catalog") throw e;
						errors.push(`${id}: ${code(e)}`);
					}
				}
			} catch (e) {
				if (code(e) === "stale_catalog") throw e;
				errors.push(`${selector || "all"}: ${code(e)}`);
			}
		}

		try {
			for (const selector of new Set(await publicSelectors(control, signal))) {
				if (selector === profile?.trim()) continue;
				try {
					const { rev, profiles } = await fetchProfiles(selector);
					ingest(selector, rev, profiles, ["service"]);
				} catch (e) {
					if (code(e) === "stale_catalog") throw e;
					errors.push(`${selector}: ${code(e)}`);
				}
			}
		} catch (e) {
			if (code(e) === "stale_catalog") throw e;
			errors.push(`public-selectors: ${code(e)}`);
		}
		return { targets: [...targets.values()], errors, discoveredAt: Date.now() };
	};
}
