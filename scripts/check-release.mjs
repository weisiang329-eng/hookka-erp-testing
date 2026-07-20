import { getReleaseMetadata } from "./lib/release-metadata.mjs";

const release = getReleaseMetadata();
const expectedChannel = process.argv
  .find((arg) => arg.startsWith("--channel="))
  ?.slice("--channel=".length);
const expectedSha = process.argv
  .find((arg) => arg.startsWith("--sha="))
  ?.slice("--sha=".length)
  .toLowerCase();

if (expectedChannel && release.channel !== expectedChannel) {
  throw new Error(`Expected channel ${expectedChannel}, got ${release.channel}`);
}
if (expectedSha && release.commitSha !== expectedSha) {
  throw new Error(`Expected commit ${expectedSha}, got ${release.commitSha}`);
}

console.log(JSON.stringify(release, null, 2));
