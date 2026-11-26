import { dormantBundleFile } from "../../domains/capabilities";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import { harness } from "../toolchain/toolchain.fixture";

/** Publishes the legacy Collaboration sessions in a harness that is already built (a test that composes its own). */
export async function importLegacyTask(
	host: Pick<Awaited<ReturnType<typeof harness>>, "store" | "toolchain">,
) {
	const result = await host.store.write((db) =>
		host.toolchain.capabilities.importBundleInTransaction(
			db,
			dormantBundleFile("collaboration.task"),
			bundleHostOf(host.toolchain.registry),
		),
	);
	if (result.issues.length)
		throw new Error("legacy_collaboration_bundle_rejected");
}

/** Exercise legacy Collaboration sessions without publishing them in the product seed. */
export async function legacyTaskHarness(
	options: Parameters<typeof harness>[0],
) {
	const host = await harness(options);
	try {
		await importLegacyTask(host);
		return host;
	} catch (error) {
		await host.close();
		throw error;
	}
}
