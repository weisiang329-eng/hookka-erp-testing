/**
 * Recover BOM Master Template records from Chrome's Local Storage leveldb files.
 * Walks every Chrome user profile on this Windows machine, opens each Local
 * Storage leveldb read-only, and extracts any entries whose key text contains
 * "bom-master-template", "bom-master-templates-index", or "hookka-bom-templates-v2".
 *
 * Output: ./recovered-bom-templates.json (repo root)
 */

import { ClassicLevel } from 'classic-level';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHROME_USER_DATA = 'C:/Users/User/AppData/Local/Google/Chrome/User Data';
const PROFILE_REGEX = /^(Default|Profile \d+)$/;
const MATCH_TOKENS = [
  'bom-master-template',
  'bom-master-templates-index',
  'hookka-bom-templates-v2',
];
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'recovered-bom-templates.json');

type RecoveredEntry = {
  profile: string;
  origin: string;
  key: string;
  value: unknown;
  rawValueText?: string;
};

/**
 * Decode a Chrome local-storage key buffer.
 * Chrome keys for local-storage come in two flavors:
 *   1. `META:<origin>\x00` prefix followed by metadata (we don't care about
 *      value content for these, but we still return decoded form)
 *   2. Actual user-data: the key buffer is `_<origin>\x00\x01<key-utf16-le>`
 *      where the leading `_` is a scheme marker and `\x01` is the UTF-16 tag.
 *
 * Returns { origin, keyText } where either may be "unknown" / "" if not parseable.
 */
function decodeKey(buf: Buffer): { origin: string; keyText: string; kind: string } {
  // META:<origin>\x00...
  if (buf.length > 5 && buf.slice(0, 5).toString('latin1') === 'META:') {
    const nullIdx = buf.indexOf(0x00, 5);
    if (nullIdx > 5) {
      const origin = buf.slice(5, nullIdx).toString('utf8');
      return { origin, keyText: '', kind: 'META' };
    }
  }
  // _<origin>\x00<tag><key>
  if (buf.length > 2 && buf[0] === 0x5f /* '_' */) {
    const nullIdx = buf.indexOf(0x00, 1);
    if (nullIdx > 1) {
      const origin = buf.slice(1, nullIdx).toString('utf8');
      // After null byte: 1-byte version tag, then key bytes
      // Chrome local-storage key encoding:
      //   tag 0x00 → UTF-16 LE
      //   tag 0x01 → Latin-1 / ASCII (one byte per char)
      const versionTag = buf[nullIdx + 1];
      const keyBody = buf.slice(nullIdx + 2);
      let keyText = '';
      if (versionTag === 0x00) {
        keyText = keyBody.toString('utf16le');
      } else if (versionTag === 0x01) {
        keyText = keyBody.toString('latin1');
      } else {
        // Unknown tag → best-effort Latin-1 of full remainder
        keyText = buf.slice(nullIdx + 1).toString('latin1');
      }
      return { origin, keyText, kind: 'DATA' };
    }
  }
  // Fallback: treat entire buffer as utf-8
  return { origin: 'unknown', keyText: buf.toString('utf8'), kind: 'RAW' };
}

/**
 * Decode a Chrome local-storage value buffer.
 * Version tag:
 *   0x00 → UTF-16 LE
 *   0x01 → Latin-1 / ASCII
 */
function decodeValue(buf: Buffer): string {
  if (buf.length === 0) return '';
  const tag = buf[0];
  const body = buf.slice(1);
  if (tag === 0x00) return body.toString('utf16le');
  if (tag === 0x01) return body.toString('latin1');
  // Unknown tag — best-effort latin1 of full buffer
  return buf.toString('latin1');
}

function shouldKeep(keyText: string): boolean {
  const lower = keyText.toLowerCase();
  return MATCH_TOKENS.some((t) => lower.includes(t));
}

async function scanProfile(profileName: string): Promise<RecoveredEntry[]> {
  const leveldbPath = path.join(
    CHROME_USER_DATA,
    profileName,
    'Local Storage',
    'leveldb',
  );
  if (!fs.existsSync(leveldbPath)) {
    return [];
  }

  // Open read-only; keys and values as Buffers so we can decode manually.
  const db = new ClassicLevel<Buffer, Buffer>(leveldbPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    createIfMissing: false,
    errorIfExists: false,
    readOnly: true,
  });

  try {
    await db.open({ passive: false });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // EAGAIN / EBUSY / LOCK failure → Chrome is holding the lock
    if (/LOCK|EAGAIN|EBUSY|already held|resource temporarily unavailable/i.test(msg)) {
      throw new Error(
        `LOCKED:${profileName}:${msg}`,
      );
    }
    throw err;
  }

  const entries: RecoveredEntry[] = [];
  try {
    for await (const [kBuf, vBuf] of db.iterator()) {
      const { origin, keyText } = decodeKey(kBuf);
      if (!keyText) continue;
      if (!shouldKeep(keyText)) continue;
      const rawValueText = decodeValue(vBuf);
      let parsed: unknown = rawValueText;
      try {
        parsed = JSON.parse(rawValueText);
      } catch {
        // leave as string
      }
      entries.push({
        profile: profileName,
        origin,
        key: keyText,
        value: parsed,
        rawValueText:
          typeof parsed === 'object' ? undefined : rawValueText, // keep raw only if not object
      });
    }
  } finally {
    await db.close();
  }
  return entries;
}

async function main() {
  if (!fs.existsSync(CHROME_USER_DATA)) {
    console.error(`Chrome User Data not found at ${CHROME_USER_DATA}`);
    process.exit(1);
  }

  const profileNames = fs
    .readdirSync(CHROME_USER_DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PROFILE_REGEX.test(d.name))
    .map((d) => d.name)
    .sort();

  const all: RecoveredEntry[] = [];
  const profilesWithData = new Set<string>();
  const errors: { profile: string; error: string }[] = [];

  for (const profile of profileNames) {
    try {
      const rows = await scanProfile(profile);
      if (rows.length > 0) {
        profilesWithData.add(profile);
        all.push(...rows);
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      errors.push({ profile, error: msg });
      if (msg.startsWith('LOCKED:')) {
        console.error(
          `\n[LOCKED] Profile "${profile}" is locked by a running Chrome process.`,
        );
        console.error(
          'Chrome is still running — user must close ALL Chrome windows + tray processes before retry.',
        );
        console.error(
          'Check: Task Manager → End all chrome.exe / GoogleCrashHandler processes.',
        );
        process.exit(2);
      }
    }
  }

  // Sort: profile > origin > key
  all.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    if (a.origin !== b.origin) return a.origin.localeCompare(b.origin);
    return a.key.localeCompare(b.key);
  });

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        recoveredAt: new Date().toISOString(),
        scannedProfiles: profileNames,
        profilesWithData: Array.from(profilesWithData).sort(),
        errors,
        totalEntries: all.length,
        entries: all,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(
    `Found ${all.length} templates across ${profilesWithData.size} profiles. Saved to ${OUTPUT_FILE}`,
  );
  if (errors.length > 0) {
    console.log(`Note: ${errors.length} profile(s) had read errors:`);
    for (const e of errors) console.log(`  - ${e.profile}: ${e.error}`);
  }
}

main().catch((err) => {
  console.error('Unrecoverable error:', err);
  process.exit(1);
});
