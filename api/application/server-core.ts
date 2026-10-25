import { dirname, join, resolve } from "node:path";
import {
	createGoogleAccounts,
	googleProviderFromEnv,
	type GoogleProvider,
} from "../domains/google-accounts";
import {
	createAttitudeDataset,
	openAttitudeStore,
} from "../domains/attitude-dataset";
import { createConversationService } from "../domains/conversation";
import { createSettings } from "../domains/settings";
import { createInference, createCloudAgents } from "../domains/inference";
import { createQueue } from "../domains/queue";
import { createActivityRecorder } from "../domains/larm";
import { createTtsDictionary } from "../domains/tts-dictionary";
import { createServiceTests } from "../domains/service-tests";
import {
	createWebResearch,
	createWebAcquisition,
	createWebCache,
	openWebCache,
} from "../domains/web-research";
import { getLogger } from "../infrastructure/logger";
import { openStore } from "../infrastructure/sqlite";
import type { Config } from "../infrastructure/config";
import { createChanges } from "./events";
import { legacyOrder, migrations } from "./migrations";
import { createWebReview } from "./toolchain/web-content-review";

const log = getLogger("server");

/** The store and the services every other group is built on: conversation, settings, inference, queue. */
export async function buildCore(
	config: Config,
	dependencies: { googleProvider?: GoogleProvider },
) {
	const { dbPath } = config;
	const store = openStore(dbPath, migrations, { legacyOrder });
	const changes = createChanges();
	const unsubscribeCommits = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath, env: config.env });
	const googleAccounts = createGoogleAccounts(store, {
		key: () => settings.derivedKey("google-accounts.credentials"),
		secureCookies: new URL(config.origin).protocol === "https:",
		provider:
			dependencies.googleProvider ??
			googleProviderFromEnv(config.env, config.origin),
	});
	const ttsDictionary = createTtsDictionary(store);
	const datasetPath = resolve(config.attitudeDatasetPath);
	const datasetStore = openAttitudeStore(datasetPath);
	const attitudeDataset = createAttitudeDataset(datasetStore, datasetPath);
	await attitudeDataset.recover();
	// Monitoring reads these; the judge and embedding calls leave no attempt record of their own.
	const activity = {
		judge: createActivityRecorder(),
		embedding: createActivityRecorder(),
	};
	const inference = createInference(store, settings, {
		cloudAgents: createCloudAgents(config.env, {
			codexExecutable: config.researchCodexExecutable,
		}),
		token: config.larmToken,
		providerHosts: config.larmProviderHosts,
		keepLarmConnection: true,
		speechText: ttsDictionary.apply,
		attitudeDataset,
		judgeActivity: activity.judge,
	});
	const unsubscribeStatus = inference.onChange(() => changes.publish());
	const serviceTests = createServiceTests(store, settings, inference, {
		token: config.larmToken,
	});
	const queue = createQueue(store, {
		resourceAliases: { "larm.llm": "inference.llm" },
		resources: { "inference.llm": 1, "inference.aux": 2, "web.fetch": 6 },
	});
	return {
		store,
		changes,
		unsubscribeCommits,
		conversation,
		settings,
		googleAccounts,
		ttsDictionary,
		datasetStore,
		attitudeDataset,
		inference,
		unsubscribeStatus,
		serviceTests,
		queue,
		activity,
	};
}
export type Core = Awaited<ReturnType<typeof buildCore>>;

/** Web research on its own cache database; an unopenable cache only disables caching. */
export function buildWebResearch(
	config: Config,
	core: Pick<Core, "store" | "queue" | "inference">,
) {
	const { store, queue, inference } = core;
	const cachePath = resolve(
		join(dirname(config.dbPath), "cache/web-research.sqlite3"),
	);
	let webCache: ReturnType<typeof createWebCache> | undefined;
	try {
		webCache = createWebCache(openWebCache(cachePath), { path: cachePath });
	} catch {
		log.warn("web.cache_unavailable", { reason: "cache_open_failed" });
	}
	return createWebResearch({
		store,
		queue,
		cache: webCache,
		review: createWebReview(store, inference),
		acquisition: createWebAcquisition({
			review: createWebReview(store, inference),
		}),
		acquisitionTimeoutMs: 30000,
	});
}
