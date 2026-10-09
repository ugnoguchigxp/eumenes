import { migration as supervisionMigration } from "../domains/coding-supervision";
import { migration as taskReportsMigration } from "../domains/task-reports";
import { backgroundControlMigration } from "../domains/inference";
import {
	learnedMigration as capabilitiesLearnedMigration,
	migration as capabilitiesMigration,
} from "../domains/capabilities";
import { migration as researchRoutesMigration } from "../domains/research-routes";
import {
	migration as toolRuntimeMigration,
	routeGrantMigration as toolRouteGrantMigration,
	supersedeMigration as toolSupersedeMigration,
	actionMigration as toolActionMigration,
} from "../domains/tool-runtime";
import {
	acquisitionMigration as agentAcquisitionMigration,
	migration as agentRuntimeMigration,
	actionResultMigration as agentActionResultMigration,
} from "../domains/agent-runtime";
import { controlMigration } from "../domains/inference";
import {
	agentLinkMigration,
	worldStateMigration as dialogueWorldStateMigration,
} from "../domains/dialogue";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import { migrations as worldPackageMigrations } from "eumenes-world-model/sqlite";
import { migration as serviceTestsMigration } from "../domains/service-tests";
import { migration as tasksMigration } from "../domains/tasks";
import { migration as codingMigration } from "../domains/coding";
import {
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	migration as conversationMigration,
	outboxMigration as conversationOutboxMigration,
	retractionMigration as conversationRetractionMigration,
} from "../domains/conversation";
import {
	migration as goalsMigration,
	operationMigration as goalsOperationMigration,
} from "../domains/goals";
import { migration as continuityMigration } from "../domains/continuity";
import {
	migration as dialogueMigration,
	queueLinkMigration as dialogueQueueLinkMigration,
} from "../domains/dialogue";
import { migration as memoryMigration } from "../domains/memory";
import {
	attemptTimeoutMigration as webAttemptTimeoutMigration,
	migration as webResearchMigration,
} from "../domains/web-research";
import {
	diagnosticsMigration as inferenceDiagnosticsMigration,
	migration as inferenceMigration,
	parentsMigration as inferenceParentsMigration,
} from "../domains/inference";
import {
	hostStateMigration as worldHostStateMigration,
	lifecycleMigration as worldLifecycleMigration,
	usageMigration as worldUsageMigration,
	guardMigration as worldGuardMigration,
	extractionMigration as worldExtractionMigration,
	runtimeMigration as worldRuntimeMigration,
	gapTaskMigration as worldGapTaskMigration,
} from "../domains/world";
import { migration as queueMigration } from "../domains/queue";
import { migration as schedulerMigration } from "../domains/scheduler";
import { migration as timersMigration } from "../domains/timers";
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
	// World integration (P3-03/04): appended after every deployed migration, never reordered.
	conversationOutboxMigration,
	goalsMigration,
	tasksMigration,
	// Retraction tombstone column: appended last, never reordered.
	conversationRetractionMigration,
	// Goal idempotency keys: appended after the already-listed goals migration.
	goalsOperationMigration,
	// Research-route learning (2026-10-09): appended last, never reordered.
	capabilitiesLearnedMigration,
	agentAcquisitionMigration,
	researchRoutesMigration,
	webAttemptTimeoutMigration,
	toolRouteGrantMigration,
	toolSupersedeMigration,
	// World package migrations (P3-06): appended after EVERY entry above, then the host-owned
	// world_host_* state. Never reorder, edit or insert before them; later work appends below.
	...worldPackageMigrations,
	worldHostStateMigration,
	// World lifecycle (P3-05): forget intake, confirmations, registered dependents, restore marker.
	worldLifecycleMigration,
	// World answer adoption (P3-07): the UsageReceipt of an adopted World-backed answer.
	worldUsageMigration,
	// Timers (2026-10-09): appended after every deployed migration, never reordered.
	timersMigration,
	agentActionResultMigration,
	toolActionMigration,
	codingMigration,
	// World hardening (review round 1): initial-sync flag, release-pending marks, abandoned forget parts.
	worldGuardMigration,
	// World answer release (P3-08): whether a run read World or was blocked by it.
	dialogueWorldStateMigration,
	backgroundControlMigration,
	taskReportsMigration,
	supervisionMigration,
	// World continuous input (P4-01/P4-02): host record of delivered extraction events; appended at the very tail.
	worldExtractionMigration,
	// World runtime observation (P4-04): host trace of verified ledger results behind Outcomes; the very tail.
	worldRuntimeMigration,
	// World decision API (P5-01): which Gap already has an investigation Task (hashed key only); the very tail.
	worldGapTaskMigration,
];
