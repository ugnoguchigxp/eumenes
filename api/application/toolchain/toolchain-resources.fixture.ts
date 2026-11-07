import type { HarnessOptions } from "./toolchain-harness-options.fixture";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Capabilities } from "../../domains/capabilities";
import { createResourceAccess } from "../resources/access";
import { createImageResourceAdapter } from "../../domains/image";
import { createMusicResourceAdapters } from "../../domains/music";
import { createPursuitReportResourceAdapter } from "../../domains/pursuit";
import type { ResourceKind } from "../../domains/resources";
export function fixtureResources(
	store: SqliteStore,
	capabilities: Capabilities,
	options: HarnessOptions,
	image: unknown,
	music: unknown,
) {
	const resources =
		options.pursuit || options.resources
			? createResourceAccess({
					store,
					kinds: () =>
						store.read((db) =>
							capabilities.resourceKindsInTransaction(db),
						) as ResourceKind[],
					adapters: [
						createPursuitReportResourceAdapter(store),
						...(image ? [createImageResourceAdapter({ store })] : []),
						...(music
							? createMusicResourceAdapters({
									store,
									gateway: options.musicGateway!,
								})
							: []),
					],
				})
			: undefined;
	return resources;
}
