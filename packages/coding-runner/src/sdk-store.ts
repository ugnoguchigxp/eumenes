import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	atomicWrite,
	canonical,
	digest,
	privateDirectory,
	readPrivate,
	totalSize,
} from "./storage";
import {
	sdkId,
	type SdkActivity,
	type SdkReceipt,
	type SdkSpec,
} from "./sdk-contracts";
import { sdkReceiptSchema } from "./sdk-schema";

/** Execution bookkeeping only. Native Codex sessions remain the sole transcript store. */
export class SdkStore {
	constructor(readonly root: string) {
		privateDirectory(root);
		privateDirectory(join(root, "sdk-runs"));
		privateDirectory(join(root, "sdk-workspaces"));
	}
	path(id: string) {
		return join(this.root, "sdk-runs", sdkId.parse(id));
	}
	ids() {
		return readdirSync(join(this.root, "sdk-runs")).filter(
			(id) => sdkId.safeParse(id).success,
		);
	}
	read(id: string): SdkReceipt | null {
		const path = join(this.path(id), "receipt.json");
		return existsSync(path)
			? sdkReceiptSchema.parse(JSON.parse(readPrivate(path)))
			: null;
	}
	spec(id: string): SdkSpec {
		return JSON.parse(readPrivate(join(this.path(id), "spec.json")));
	}
	create(spec: SdkSpec, epoch: string): SdkReceipt {
		if (totalSize(this.root) > 200 * 1024 * 1024)
			throw new Error("sdk_spool_full");
		const path = privateDirectory(this.path(spec.executionId));
		privateDirectory(join(path, "events"));
		const at = new Date().toISOString();
		const receipt: SdkReceipt = {
			protocol: spec.protocol,
			executionId: spec.executionId,
			ownerId: spec.ownerId,
			workspaceId: spec.workspaceId,
			digest: digest(canonical(spec)),
			epoch,
			state: "accepted",
			seq: 0,
			managedExecutionStopped: true,
			workspaceReleaseConfirmed: true,
			workspaceHeld: true,
			createdAt: at,
			updatedAt: at,
		};
		atomicWrite(join(path, "spec.json"), spec);
		this.save(receipt);
		return receipt;
	}
	save(receipt: SdkReceipt) {
		receipt.updatedAt = new Date().toISOString();
		atomicWrite(join(this.path(receipt.executionId), "receipt.json"), receipt);
	}
	append(receipt: SdkReceipt, activity: Omit<SdkActivity, "seq" | "at">) {
		if (receipt.seq >= 8000) throw new Error("sdk_event_limit");
		const event: SdkActivity = {
			...activity,
			seq: receipt.seq + 1,
			at: new Date().toISOString(),
		};
		atomicWrite(
			join(this.path(receipt.executionId), "events", `${event.seq}.json`),
			event,
		);
		receipt.seq = event.seq;
		this.save(receipt);
	}
	events(id: string, after: number, limit: number): SdkActivity[] {
		const receipt = this.read(id);
		if (!receipt) throw new Error("sdk_execution_missing");
		const events: SdkActivity[] = [];
		for (
			let seq = after + 1;
			seq <= Math.min(receipt.seq, after + limit);
			seq++
		)
			events.push(
				JSON.parse(readPrivate(join(this.path(id), "events", `${seq}.json`))),
			);
		return events;
	}
}
