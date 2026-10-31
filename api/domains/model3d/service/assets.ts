import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Model3dAsset, Model3dLarm } from "../contracts";
import { forgetAsset, rememberAssets } from "../repository";

const signalOf = (signal: AbortSignal, ms: number) =>
	AbortSignal.any([signal, AbortSignal.timeout(ms)]);

/** LARM's saved assets, read and changed directly; the local index follows each answer. */
export function createModel3dAssets(
	store: SqliteStore,
	larmOf: () => Model3dLarm | null,
	onStatus: (status: { available: boolean; reason: string | null }) => void,
) {
	function larm() {
		const l = larmOf();
		if (!l) throw new Error("model3d_larm_unconfigured");
		return l;
	}
	return {
		/** Whether LARM publishes the 3D service right now. */
		async status(signal: AbortSignal) {
			const l = larmOf();
			if (!l) return { available: false, reason: "model3d_larm_unconfigured" };
			let status: { available: boolean; reason: string | null };
			try {
				const found = await l.discover(signalOf(signal, 15_000));
				status = found.mesh
					? { available: true, reason: null }
					: { available: false, reason: "model3d_service_unavailable" };
			} catch {
				status = { available: false, reason: "model3d_unreachable" };
			}
			onStatus(status);
			return status;
		},
		async assets(
			owner: string,
			query: Parameters<Model3dLarm["assets"]>[0],
			signal: AbortSignal,
		) {
			const page = await larm().assets(query, signalOf(signal, 20_000));
			await store.write((db) => rememberAssets(db, owner, page.assets));
			return page;
		},
		async asset(owner: string, id: string, signal: AbortSignal) {
			try {
				const a = await larm().asset(id, signalOf(signal, 20_000));
				await store.write((db) => rememberAssets(db, owner, [a]));
				return a;
			} catch (e) {
				if (e instanceof Error && e.message === "larm_http_404")
					await store.write((db) => forgetAsset(db, owner, id));
				throw e;
			}
		},
		async update(
			owner: string,
			id: string,
			patch: { title?: string; tags?: string[] },
			signal: AbortSignal,
		) {
			const a: Model3dAsset = await larm().update(
				id,
				patch,
				signalOf(signal, 20_000),
			);
			await store.write((db) => rememberAssets(db, owner, [a]));
			return a;
		},
		/** An asset LARM no longer has counts as removed. */
		async remove(owner: string, id: string, signal: AbortSignal) {
			try {
				await larm().remove(id, signalOf(signal, 20_000));
			} catch (e) {
				if (!(e instanceof Error && e.message === "larm_http_404")) throw e;
			}
			await store.write((db) => forgetAsset(db, owner, id));
		},
		content: (id: string, signal: AbortSignal) =>
			larm().content(id, signalOf(signal, 120_000)),
	};
}
