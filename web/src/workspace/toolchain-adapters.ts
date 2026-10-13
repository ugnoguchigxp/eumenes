import { createWebAdapterRegistry } from "../domains/toolchain-artifacts";
import { timerWebAdapter } from "../domains/timers/toolchain-adapter";

/** Every domain adapter the common artifact host can render. Adding a domain adds one line. */
export const toolchainWebAdapters = createWebAdapterRegistry([timerWebAdapter]);
