import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { z } from "zod";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { ImageService } from "../../domains/image";
import { prototypeImageRequest } from "../../domains/image/contracts";
import { imageArtifactId } from "../../domains/larm/contracts";
import {
	imageGrantInTransaction,
	setImageGrantInTransaction,
	type PrototypeService,
} from "../../domains/prototype";
import { worksImagePolicyChange } from "../../domains/prototype/contracts";

const uuid = z.uuid();
type WorksImages = ReturnType<typeof worksImages>;
export function worksImages(store: SqliteStore, works: PrototypeService) {
	const features = (id: string) => works.features(id);
	return {
		features,
		inputVersion: works.inputVersion,
		allows(db: Database, id: string, revision: number) {
			try {
				const grant = imageGrantInTransaction(db, id);
				return (
					grant.revision === revision &&
					grant.enabled &&
					features(id).includes("media.image.generate")
				);
			} catch {
				return false;
			}
		},
		policy(id: string) {
			const capabilities = features(id);
			const grant = store.read((db) => imageGrantInTransaction(db, id));
			const canRead = capabilities.includes("library.image.read");
			const canGenerate = capabilities.includes("media.image.generate");
			return {
				revision: grant.revision,
				canRead,
				canGenerate,
				assets: canRead ? grant.assets : [],
				enabled: canGenerate && grant.enabled,
			};
		},
		store,
	};
}

export function registerWorksImageRoutes(
	app: Hono,
	controls: WorksImages,
	image: ImageService,
) {
	const base = "/api/prototypes/:id/images";
	const { store } = controls;
	function response(bytes: Uint8Array | undefined, mime: string | undefined) {
		if (
			!bytes?.length ||
			bytes.length > 16 * 1024 * 1024 ||
			(mime !== "image/png" && mime !== "image/webp")
		)
			throw new Error("prototype_image_content_unavailable");
		return new Response(new Uint8Array(bytes), {
			headers: {
				"Content-Type": mime,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}
	const safe = (e: unknown) => {
		const code =
			e instanceof Error && /^prototype_[a-z_]+$/.test(e.message)
				? e.message
				: "prototype_image_unavailable";
		const status = code.endsWith("_not_found")
			? 404
			: code === "prototype_grant_revoked"
				? 403
				: code.endsWith("_conflict")
					? 409
					: 400;
		return Response.json(
			{ error: code },
			{ status, headers: { "Cache-Control": "no-store" } },
		);
	};
	app.get(base, (c) => {
		try {
			return c.json(controls.policy(uuid.parse(c.req.param("id"))));
		} catch (e) {
			return safe(e);
		}
	});
	app.post(base + "/grant", async (c) => {
		try {
			const id = uuid.parse(c.req.param("id"));
			const input = worksImagePolicyChange.parse(await c.req.json());
			const access = controls.policy(id);
			if (
				(input.enabled && !access.canGenerate) ||
				(input.assetIds.length && !access.canRead)
			)
				throw new Error("prototype_grant_revoked");
			const connection = image.libraryBinding();
			const signal = AbortSignal.any([
				c.req.raw.signal,
				AbortSignal.timeout(15_000),
			]);
			const assets = await Promise.all(
				[...new Set(input.assetIds)].map(async (item) => {
					const artifactId = imageArtifactId.parse(item);
					const found = await image.library().get(artifactId, signal);
					if (found.id !== artifactId || found.bytes > 16 * 1024 * 1024)
						throw new Error("prototype_image_not_found");
					return {
						id: found.id,
						label: `画像 ${found.width} × ${found.height} · ${found.createdAt.slice(0, 10)}`,
					};
				}),
			);
			const jobs = await store.write((db) => {
				const current = controls.features(id);
				if (
					(input.enabled && !current.includes("media.image.generate")) ||
					(assets.length && !current.includes("library.image.read")) ||
					connection !== image.libraryBinding()
				)
					throw new Error("prototype_grant_revoked");
				const old = imageGrantInTransaction(db, id);
				if (old.revision !== input.expectedRevision)
					throw new Error("prototype_grant_conflict");
				if (
					old.connection === connection &&
					old.enabled === input.enabled &&
					JSON.stringify(old.assets) === JSON.stringify(assets)
				)
					return [];
				setImageGrantInTransaction(db, id, {
					revision: input.expectedRevision,
					enabled: input.enabled,
					assets,
					connection,
				});
				return image.prototype.revokeInTransaction(db, id);
			});
			image.prototype.flush(jobs);
			return c.json(controls.policy(id));
		} catch (e) {
			return safe(e);
		}
	});
	app.get(base + "/assets/:image", async (c) => {
		try {
			const id = uuid.parse(c.req.param("id"));
			const artifactId = imageArtifactId.parse(c.req.param("image"));
			const verify = () => {
				const allowed = controls.policy(id);
				const binding = store.read(
					(db) => imageGrantInTransaction(db, id).connection,
				);
				if (
					binding !== image.libraryBinding() ||
					!allowed.assets.some((a) => a.id === artifactId)
				)
					throw new Error("prototype_grant_revoked");
				return allowed.revision;
			};
			const revision = verify();
			const value = await image.content(
				artifactId,
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
			);
			if (verify() !== revision) throw new Error("prototype_grant_revoked");
			return response(value.bytes, value.mime);
		} catch (e) {
			return safe(e);
		}
	});
	app.get(base + "/generations", (c) => {
		try {
			const id = uuid.parse(c.req.param("id"));
			const policy = controls.policy(id);
			return c.json(
				policy.enabled ? image.prototype.list(id, policy.revision) : [],
			);
		} catch (e) {
			return safe(e);
		}
	});
	app.post(base + "/generations", async (c) => {
		try {
			const id = uuid.parse(c.req.param("id"));
			const input = prototypeImageRequest.parse(await c.req.json());
			const result = await store.write((db) =>
				image.prototype.startInTransaction(
					db,
					id,
					imageGrantInTransaction(db, id).revision,
					input,
					() => controls.inputVersion(id),
				),
			);
			image.prototype.publish();
			return c.json(result, 202);
		} catch (e) {
			return safe(e);
		}
	});
	const item = base + "/generations/:operation";
	app.get(item, (c) => {
		try {
			return c.json(
				image.prototype.status(
					uuid.parse(c.req.param("id")),
					uuid.parse(c.req.param("operation")),
				),
			);
		} catch (e) {
			return safe(e);
		}
	});
	app.delete(item, async (c) => {
		try {
			return c.json(
				await image.prototype.cancel(
					uuid.parse(c.req.param("id")),
					uuid.parse(c.req.param("operation")),
				),
			);
		} catch (e) {
			return safe(e);
		}
	});
	app.get(item + "/content", async (c) => {
		try {
			const value = await image.prototype.content(
				uuid.parse(c.req.param("id")),
				uuid.parse(c.req.param("operation")),
				AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
			);
			return response(value.bytes, value.mime);
		} catch (e) {
			return safe(e);
		}
	});
}
