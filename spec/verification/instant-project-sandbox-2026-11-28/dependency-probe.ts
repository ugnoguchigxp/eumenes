// P0 fixture for admission and resumption. Registry metadata, the managed
// publication result and the work record are all disposable fixed inputs.
import { strict as assert } from "node:assert";

const now = Date.UTC(2026, 10, 28);
const day = 24 * 60 * 60 * 1000;
type Package = { name: string; version: string; publishedAt: number; scripts?: Record<string, string> };
type Request = { workId: string; registration: number; package: Package };
type Work = { id: string; registration: number; environment: string; pending?: Request };

function checkMetadata(candidate: Package) {
	if (!Number.isFinite(candidate.publishedAt) || now - candidate.publishedAt < 7 * day)
		throw new Error("release_too_recent");
	const installHooks = ["preinstall", "install", "postinstall"];
	if (installHooks.some((hook) => candidate.scripts?.[hook]))
		throw new Error("package_requires_install_script");
}

const mature = { name: "fixture", version: "1.0.0", publishedAt: now - 8 * day };
assert.throws(() => checkMetadata({ ...mature, publishedAt: now - 7 * day + 1 }), /release_too_recent/);
assert.doesNotThrow(() => checkMetadata({ ...mature, publishedAt: now - 7 * day }));
assert.throws(() => checkMetadata({ ...mature, scripts: { postinstall: "fixture only" } }), /install_script/);

const work: Work = { id: "work-a", registration: 1, environment: "1.0" };
const other: Work = { id: "work-b", registration: 1, environment: "1.0" };
function propose(target: Work, candidate: Package) {
	checkMetadata(candidate);
	target.pending = { workId: target.id, registration: target.registration, package: candidate };
	return target.pending;
}

let publications = 0;
function approve(target: Work, request: Request) {
	if (request !== target.pending || request.registration !== target.registration)
		throw new Error("approval_no_longer_current");
	// The shared environment's publisher supplies this immutable version.
	const publishedVersion = "1.1";
	publications++;
	target.environment = publishedVersion;
	delete target.pending;
	return target.id;
}

const outdated = propose(work, mature);
work.registration++;
assert.throws(() => approve(work, outdated), /approval_no_longer_current/);
assert.equal(publications, 0);
const request = propose(work, mature);
assert.equal(work.environment, "1.0");
assert.equal(approve(work, request), "work-a");
assert.equal(work.environment, "1.1");
assert.equal(other.environment, "1.0");
assert.throws(() => approve(work, request), /approval_no_longer_current/);
assert.equal(publications, 1);
console.log(JSON.stringify({
	youngReleaseRejected: true,
	installLifecycleScriptRejected: true,
	noPublicationBeforeApproval: true,
	staleApprovalRejected: true,
	sameWorkIdResumed: true,
	otherWorkKeptItsFixedVersion: true,
	approvalReplayDoesNotRepublish: true,
}, null, 2));
