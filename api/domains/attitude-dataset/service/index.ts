import { createHmac } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { type SpeechDelivery } from "../../delivery";
import { type Identity, type Sample, type VoiceAdoption } from "../contracts";
import * as records from "../repository/records";
import { adoption, readAdoption, type SavedAdoption } from "./adoption";
import { createDatasetCollection } from "./collection";
import { createDatasetReview } from "./review";

const target = 300;
export function createAttitudeDataset(store: SqliteStore, path: string) {
	const pending = new Set<Promise<unknown>>();
	let lifetime = new AbortController();
	let volatileErrors = 0;
	const control = () => store.read((db) => records.readControl(db)!);
	const hash = (value: string) =>
		createHmac("sha256", control().salt).update(value).digest("hex");
	const unitId = (identity: Identity) =>
		hash(
			JSON.stringify([
				identity.conversationId,
				identity.turnId,
				identity.granularity,
				identity.chunkOrder,
			]),
		);
	const units = () => store.read((db) => records.listUnits(db));
	const samples = () =>
		units()
			.filter((u) => u.sample)
			.map((u) => JSON.parse(u.sample!) as Sample);
	const review = createDatasetReview({
		target,
		store,
		path,
		control,
		units,
		samples,
		volatileErrors: () => volatileErrors,
	});
	const { status } = review;
	function track(work: Promise<unknown>) {
		pending.add(work);
		void work
			.catch(async () => {
				volatileErrors++;
				await store.write((db) => records.recordError(db)).catch(() => {});
			})
			.finally(() => pending.delete(work));
	}
	async function setEnabled(enabled: boolean) {
		if (!enabled) {
			lifetime.abort();
			lifetime = new AbortController();
		}
		await store.write((db) => {
			const previous = records.readControl(db)!;
			if (!!previous.enabled === enabled) return;
			const count = records.countSamples(db)!.n;
			if (enabled && count >= target)
				throw new Error("invalid_collection_target_reached");
			records.setEnabled(db, enabled ? 1 : 0);
			if (!enabled) records.cancelPending(db);
		});
		if (!enabled) await Promise.allSettled(pending);
		return status();
	}
	const { decide } = createDatasetCollection({
		target,
		store,
		control,
		unitId,
		hash,
		track,
		lifetime: () => lifetime,
		recordVolatileError: () => {
			volatileErrors++;
		},
	});
	return {
		decide,
		setEnabled,
		adopt(identity: Identity, delivery: SpeechDelivery, voice?: VoiceAdoption) {
			const id = unitId(identity);
			track(
				store.write((db) => {
					const unit = records.readUnit(db, id);
					if (!unit) return;
					const previous = records.readAdoption(db, id);
					const saved: SavedAdoption = previous
						? readAdoption(previous.delivery)
						: { delivery };
					// A replay may produce a new plan. Keep the first accepted plan and only enrich its own voice application.
					if (saved.delivery.id !== delivery.id) return;
					if (voice && !saved.voice) saved.voice = voice;
					records.saveAdoption(db, id, JSON.stringify(saved));
					if (unit.sample) {
						const sample = JSON.parse(unit.sample) as Sample;
						sample.adopted = adoption(saved.delivery, saved.voice);
						records.saveSample(db, JSON.stringify(sample), id);
					}
				}),
			);
		},
		...review,
		async recover() {
			await store.write((db) => records.recover(db));
		},
		async close() {
			await setEnabled(false);
		},
		async drain() {
			await Promise.allSettled(pending);
		},
	};
}
export type AttitudeDataset = ReturnType<typeof createAttitudeDataset>;
