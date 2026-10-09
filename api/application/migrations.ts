import { migration as capabilitiesMigration } from "../domains/capabilities";
import { migration as toolRuntimeMigration } from "../domains/tool-runtime";
import { migration as agentRuntimeMigration } from "../domains/agent-runtime";
import { controlMigration } from "../domains/inference";
import { agentLinkMigration } from "../domains/dialogue";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { migration as serviceTestsMigration } from "../domains/service-tests";
import {
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	migration as conversationMigration,
} from "../domains/conversation";
import { migration as continuityMigration } from "../domains/continuity";
import {
	migration as dialogueMigration,
	queueLinkMigration as dialogueQueueLinkMigration,
} from "../domains/dialogue";
import { migration as memoryMigration } from "../domains/memory";
import { migration as webResearchMigration } from "../domains/web-research";
import {
	diagnosticsMigration as inferenceDiagnosticsMigration,
	migration as inferenceMigration,
	parentsMigration as inferenceParentsMigration,
} from "../domains/inference";
import { migration as queueMigration } from "../domains/queue";
import { migration as schedulerMigration } from "../domains/scheduler";
import {
	epochsMigration as settingsEpochsMigration,
	migration as settingsMigration,
} from "../domains/settings";
import { migration as ttsDictionaryMigration } from "../domains/tts-dictionary";
import {
	migration as voiceMigration,
	sequenceMigration as voiceSequenceMigration,
} from "../domains/voice-dialogue";

// The earlier bookmark-style continuity domain was retired. Migrations are applied by
// position, so keep a no-op in its slot; its old tables are left untouched. The new
// `continuity` domain (goals / decisions / open questions) has its own tables, appended below.
const retiredContinuityMigration = "SELECT 1";

/**
 * Migrations are applied by position: never reorder or rewrite existing entries.
 * The first four memory package migrations are already deployed after the original
 * host block. Keep them fixed before service-tests; future package migrations append.
 */
export const hostMigrations: readonly string[] = [
	conversationMigration,
	dialogueMigration,
	voiceMigration,
	// Appended migrations: never reorder or rewrite the ones above.
	queueMigration,
	schedulerMigration,
	dialogueQueueLinkMigration,
	voiceSequenceMigration,
	retiredContinuityMigration,
	settingsMigration,
	inferenceMigration,
	settingsEpochsMigration,
	inferenceParentsMigration,
	inferenceDiagnosticsMigration,
	ttsDictionaryMigration,
	conversationAvatarMotionMigration,
	conversationAnswerDeliveryMigration,
	continuityMigration,
	memoryMigration,
];
export const migrations: readonly string[] = [
	...hostMigrations,
	...memoryPackageMigrations.slice(0, 4),
	serviceTestsMigration,
	// Package migration 5 was deployed before Web acquisition. Keep that slot fixed too.
	...memoryPackageMigrations.slice(4, 5),
	webResearchMigration,
	...memoryPackageMigrations.slice(5),
	capabilitiesMigration,
	toolRuntimeMigration,
	agentRuntimeMigration,
	controlMigration,
	agentLinkMigration,
];
