import type { Database } from "bun:sqlite";
import type { CapturedImage, ObservationEnvelope } from "eumenes-interact";
import { Refusal } from "eumenes-interact/parts";
import { CAPTURE_MAX_SIDE } from "../contracts";
import { interactHash } from "./interact-authority";
import type {
	InteractExecutionDeps,
	InteractExecutionContext,
} from "./interact-execution";
export function createInteractCapture(
	deps: InteractExecutionDeps,
	context: () => InteractExecutionContext,
	guards: {
		active: () => void;
		check: (db: Database) => void;
		observe: () => Promise<ObservationEnvelope>;
		observed: (
			tab: string,
			ref: string | undefined,
			target: string | null,
		) => ObservationEnvelope;
	},
) {
	const { active, check, observe, observed } = guards;
	return {
		capture: async (
			tab: string,
			ref: string | undefined,
			range: "viewport" | "full" | "item",
			target: string | null,
		): Promise<CapturedImage> => {
			const ctx = context();
			const fresh = ref ?? (await observe()).observationRef;
			const seen = observed(tab, fresh, target);
			const permission = deps.memory.captureApproval;
			deps.memory.captureApproval = undefined;
			if (
				!permission ||
				permission.generation !== ctx.generation ||
				permission.snapshot !== interactHash({ body: seen.body, url: seen.url })
			)
				throw new Refusal("capture_approval_stale", false);
			const r =
				range === "full"
					? "full-page"
					: range === "item"
						? "element"
						: "viewport";
			const size = await deps.driver.measure(r, target ?? undefined);
			if (size.width > CAPTURE_MAX_SIDE || size.height > CAPTURE_MAX_SIDE)
				throw new Refusal("capture_dimensions_exceeded", false);
			active();
			const bytes = await deps.driver.screenshot(
				r,
				target ?? undefined,
				ctx.signal,
			);
			active();
			const after = await observe();
			if (
				interactHash({ body: after.body, url: after.url }) !==
				permission.snapshot
			)
				throw new Refusal("capture_approval_stale", false);
			const actual = deps.encoder.pngSize(bytes);
			if (actual.width > CAPTURE_MAX_SIDE || actual.height > CAPTURE_MAX_SIDE)
				throw new Refusal("capture_dimensions_exceeded", false);
			return { mediaType: "image/png", bytes, ...actual };
		},
		async save(range: "viewport" | "full" | "item", image: CapturedImage) {
			const ctx = context();
			active();
			const encoded = await deps.encoder.encodeWebp(image.bytes, ctx.signal);
			active();
			const captureId = crypto.randomUUID();
			deps.memory.pendingCaptures ??= new Set();
			deps.memory.pendingCaptures.add(captureId);
			let file: string | undefined;
			try {
				const temp = await deps.files.writeTemp(captureId, encoded.bytes);
				file = temp;
				active();
				file = await deps.files.adopt(temp, captureId);
				await deps.store.write((db) => {
					check(db);
					db.query(
						"INSERT INTO browser_interact_captures (id,run_id,file_ref,width,height,bytes,range,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
					).run(
						captureId,
						ctx.runId,
						file!,
						encoded.width,
						encoded.height,
						encoded.bytes.length,
						range === "full"
							? "full-page"
							: range === "item"
								? "element"
								: "viewport",
						deps.now(),
						deps.now() + 7 * 86400000,
					);
				});
			} catch (e) {
				if (file) await deps.files.remove(file);
				throw e;
			} finally {
				deps.memory.pendingCaptures.delete(captureId);
			}
			return {
				captureId,
				fileName: `${captureId}.webp`,
				width: encoded.width,
				height: encoded.height,
				bytes: encoded.bytes.length,
				mediaType: "image/webp" as const,
				range,
			};
		},
	};
}
