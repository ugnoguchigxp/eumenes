const args = process.argv.slice(2);
const numbers = [2, 4, 6];
const summary = {
	count: numbers.length,
	total: numbers.reduce((sum, number) => sum + number, 0),
};

if (args.length === 1 && args[0] === "--help") {
	console.log("Usage: bun sample.mjs --format json|text");
} else if (args.length !== 2 || args[0] !== "--format") {
	console.error("Unknown option. Use --help for the supported formats.");
	process.exitCode = 2;
} else if (args[1] === "json") {
	console.log(JSON.stringify(summary));
} else if (args[1] === "text") {
	console.log(`count=${summary.count}, total=${summary.total}`);
} else {
	console.error("Unknown format. Use --help for the supported formats.");
	process.exitCode = 2;
}
