import { openStore } from "../api/infrastructure/sqlite";

const file = process.argv[2];
if (!file) throw new Error("db path required");
const store = openStore(file, []);
console.log("READY");
process.on("SIGTERM", () => {
	void store.close().then(() => process.exit(0));
});
await new Promise(() => {});
