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
import { uiCompositionsWebAdapter } from "../domains/ui-compositions/toolchain-adapter";
import { objectRecognitionScreenWebAdapter } from "../domains/object-recognition/toolchain-adapter";
import { serviceTestsWebAdapter } from "../domains/service-tests/toolchain-adapter";
import { terminalsWebAdapter } from "../domains/terminals";
import { kanbanWebAdapter, sharedKanbanWebAdapter } from "../domains/kanban";

/** Every domain adapter the common artifact host can render. Adding a domain adds one line. */
export const toolchainWebAdapters = createWebAdapterRegistry([
	googleAccountsWebAdapter,
	timerWebAdapter,
	musicScreenWebAdapter,
	imageScreenWebAdapter,
	uiCompositionsWebAdapter,
	objectRecognitionScreenWebAdapter,
	ocrWebAdapter,
	settingsWebAdapter,
	recordsWebAdapter,
	serviceTestsWebAdapter,
	terminalsWebAdapter,
	kanbanWebAdapter,
	sharedKanbanWebAdapter,
	codexTasksWebAdapter,
]);
