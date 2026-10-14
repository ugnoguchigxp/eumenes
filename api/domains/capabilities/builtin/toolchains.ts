import type { Definition } from "../contracts";
import toolchains from "../seeds/toolchains.json";

/** Legacy toolchain seeds; registration validates packages, schemas and function names. */
export const toolchainBuiltins = toolchains as Definition[];
