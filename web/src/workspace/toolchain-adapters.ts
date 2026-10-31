import { doclingWebAdapter } from "../domains/docling/toolchain-adapter";
import { dotsMessagingWebAdapter } from "../domains/dots/toolchain-adapter";
import { dotsWorkWebAdapter } from "../domains/dots/work-adapter";
import { shellWebAdapter } from "../domains/shell/toolchain-adapter";
import { computeWebAdapter } from "../domains/compute/toolchain-adapter";
import { todosWebAdapter } from "../domains/agent-runtime/toolchain-adapter";
import { codexTasksWebAdapter } from "../domains/codex-tasks/toolchain-adapter";
import { googleAccountsWebAdapter } from "../domains/google-accounts/toolchain-adapter";
import { ocrWebAdapter } from "../domains/ocr/toolchain-adapter";
import { createWebAdapterRegistry } from "../domains/toolchain-artifacts";
import {
	recordsWebAdapter,
	settingsWebAdapter,
} from "../domains/settings-data";
import { timerWebAdapter } from "../domains/timers/toolchain-adapter";
import { musicScreenWebAdapter } from "../domains/music/toolchain-adapter";
import { imageScreenWebAdapter } from "../domains/image/toolchain-adapter";
import { model3dWebAdapter } from "../domains/model3d/toolchain-adapter";
import { browserWebAdapter } from "../domains/browser/toolchain-adapter";
import { uiCompositionsWebAdapter } from "../domains/ui-compositions/toolchain-adapter";
import { pipelinesWebAdapter } from "../domains/pipelines/toolchain-adapter";
import { objectRecognitionScreenWebAdapter } from "../domains/object-recognition/toolchain-adapter";
import { serviceTestsWebAdapter } from "../domains/service-tests/toolchain-adapter";
import { terminalsWebAdapter } from "../domains/terminals";
import { kanbanWebAdapter, sharedKanbanWebAdapter } from "../domains/kanban";

/** Every domain adapter the common artifact host can render. Adding a domain adds one line. */
export const toolchainWebAdapters = createWebAdapterRegistry([
	usageWebAdapter,
	doclingWebAdapter,
	dotsMessagingWebAdapter,
	dotsWorkWebAdapter,
	todosWebAdapter,
	googleAccountsWebAdapter,
	timerWebAdapter,
	musicScreenWebAdapter,
	imageScreenWebAdapter,
	model3dWebAdapter,
	computeWebAdapter,
	browserWebAdapter,
	uiCompositionsWebAdapter,
	pipelinesWebAdapter,
	objectRecognitionScreenWebAdapter,
	ocrWebAdapter,
	settingsWebAdapter,
	recordsWebAdapter,
	serviceTestsWebAdapter,
	terminalsWebAdapter,
	shellWebAdapter,
	kanbanWebAdapter,
	sharedKanbanWebAdapter,
	codexTasksWebAdapter,
]);
import { usageWebAdapter } from "../domains/usage/toolchain-adapter";
