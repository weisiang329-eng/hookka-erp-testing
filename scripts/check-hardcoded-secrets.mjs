#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_PASSWORDS = new Set([
  "changeme",
  "example",
  "fake",
  "pass",
  "password",
  "placeholder",
  "secret",
  "test",
  "xxx",
]);

// Intentionally retain only the credential portions, never the full URL.
const CREDENTIALED_POSTGRES_URL = /\bpostgres(?:ql)?:\/\/([^:\s/"'`]+):([^@\s/"'`]+)@/giu;

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function isPlaceholderPassword(rawPassword) {
  let password = rawPassword;
  try {
    password = decodeURIComponent(rawPassword);
  } catch {
    // A malformed percent escape is still treated as a real credential.
  }
  return PLACEHOLDER_PASSWORDS.has(password.toLowerCase());
}

export function scanTextForSecrets(text, file = "<text>") {
  const findings = [];
  CREDENTIALED_POSTGRES_URL.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIALED_POSTGRES_URL)) {
    if (isPlaceholderPassword(match[2])) continue;
    findings.push({
      file,
      line: lineNumberAt(text, match.index ?? 0),
      rule: "credentialed-postgres-url",
    });
  }
  return findings;
}

export function scanTrackedFiles(cwd = process.cwd()) {
  // Include untracked, non-ignored files so the local guard catches a secret
  // before its first commit; CI naturally sees the committed tree.
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd },
  );
  const files = output.toString("utf8").split("\0").filter(Boolean);
  const findings = [];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(new URL(file.replaceAll("\\", "/"), pathToFileURL(`${cwd}/`)));
    } catch {
      continue;
    }
    if (content.includes(0)) continue;
    findings.push(...scanTextForSecrets(content.toString("utf8"), file));
  }
  return findings;
}

function main() {
  const findings = scanTrackedFiles();
  if (findings.length === 0) {
    console.log("Secret hygiene passed: no credentialed PostgreSQL URLs in repository source.");
    return;
  }

  console.error(`Secret hygiene failed: ${findings.length} finding(s).`);
  for (const finding of findings) {
    // Do not print source text: CI logs must never become a second secret leak.
    console.error(`${finding.file}:${finding.line} [${finding.rule}]`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();
