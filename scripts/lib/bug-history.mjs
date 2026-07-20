const HEADING = /^##\s+(BUG-(\d{4}-\d{2}-\d{2})-\d{3})\s*[\u2013\u2014-]\s*(.+)$/gm;
const TAG = /`([a-z][a-z0-9-]{1,48})`/g;
const TEST_PATH = /tests\/[A-Za-z0-9._/-]+\.test\.mjs\b/g;
const BARE_TEST = /(?<![A-Za-z0-9._/-])([A-Za-z0-9._-]+\.test\.mjs)\b/g;
const STATUS_MARKER = /[\u{1F7E2}\u{1F7E1}\u{1F534}]/u;

function unique(values) {
  return [...new Set(values)];
}

function trailingTags(title) {
  const matches = [...title.matchAll(TAG)];
  if (matches.length === 0) return { tags: [], title };

  let first = matches.length - 1;
  for (let i = matches.length - 2; i >= 0; i -= 1) {
    const previous = matches[i];
    const current = matches[first];
    const between = title.slice(
      (previous.index ?? 0) + previous[0].length,
      current.index,
    );
    if (between.trim() !== "") break;
    first = i;
  }

  const tagMatches = matches.slice(first);
  const tagStart = tagMatches[0]?.index ?? title.length;
  return {
    tags: tagMatches.map((match) => match[1]),
    title: title.slice(0, tagStart).trim(),
  };
}

function detectStatus(rawHeading, body) {
  const sample = `${rawHeading}\n${body.slice(0, 800)}`;
  const fixed = sample.includes("🟢");
  const progress = sample.includes("🟡");
  const identified = sample.includes("🔴");
  const formal = body.match(
    /\*\*Status:\*\*\s*(?:[^A-Za-z\s]+\s*)?([A-Za-z][A-Za-z ]+?)(?:\s*\(([\d-]+)\))?(?:\r?$|\n)/mu,
  );

  if (fixed && (progress || identified)) {
    return { status: "Partial", statusIcon: "🟡", statusDate: "" };
  }
  if (progress) {
    return { status: "Fix in progress", statusIcon: "🟡", statusDate: "" };
  }
  if (identified) {
    return { status: "Identified", statusIcon: "🔴", statusDate: "" };
  }
  if (fixed) return { status: "Fixed", statusIcon: "🟢", statusDate: "" };

  const formalStatus = formal?.[1]?.trim() ?? "Unknown";
  const formalStatusLower = formalStatus.toLowerCase();
  const formalIcon = formalStatusLower.includes("fixed")
    ? "🟢"
    : formalStatusLower.includes("progress")
      ? "🟡"
      : formalStatusLower.includes("identified")
        ? "🔴"
        : "";
  return {
    status: formalStatus,
    statusIcon: formalIcon,
    statusDate: formal?.[2] ?? "",
  };
}

function findTests(body) {
  const refs = [...body.matchAll(TEST_PATH)].map((match) => match[0]);
  for (const match of body.matchAll(BARE_TEST)) {
    const bare = match[1];
    if (!refs.some((ref) => ref.endsWith(`/${bare}`))) refs.push(`tests/${bare}`);
  }
  return unique(refs);
}

function findCommits(body) {
  const refs = [];
  const commit = /\b(?:commit|merge|shipped|deployed?)\b[^\r\n]{0,40}?\b([0-9a-f]{7,40})\b/gi;
  for (const match of body.matchAll(commit)) refs.push(match[1]);
  return unique(refs);
}

export function parseBugHistory(raw) {
  if (!raw) return [];
  const matches = [...raw.matchAll(HEADING)];
  return matches.map((match, index) => {
    const id = match[1];
    const date = match[2];
    const rawHeading = match[3].trim();
    const lineEnd = raw.indexOf("\n", match.index ?? 0);
    const bodyStart = lineEnd === -1 ? raw.length : lineEnd + 1;
    const bodyEnd = matches[index + 1]?.index ?? raw.length;
    const body = raw.slice(bodyStart, bodyEnd).trim();
    const parsedHeading = trailingTags(rawHeading);
    const legacyCategory = body.match(/\*\*Category:\*\*\s*([\w-]+)/m)?.[1];
    const categories = unique(
      parsedHeading.tags.length > 0
        ? parsedHeading.tags
        : legacyCategory
          ? [legacyCategory]
          : [],
    );
    const status = detectStatus(rawHeading, body);
    const regressionWaiver = body.match(
      /Regression(?: test)?:\s*N\/A\s*[\u2013\u2014-]\s*([^\r\n]+)/i,
    );

    return {
      id,
      date,
      title: parsedHeading.title.replace(/\s*[🟢🟡🔴].*$/u, "").trim(),
      rawHeading,
      body,
      categories,
      category: categories[0] ?? "uncategorised",
      ...status,
      statusDate: status.statusDate || date,
      tests: findTests(body),
      commits: findCommits(body),
      hasRootCause: /\*\*Root cause(?::)?\*\*\s*[:\u2013\u2014-]?/i.test(body),
      hasFix: /\*\*Fix(?::)?\*\*\s*[:(\u2013\u2014-]?/i.test(body),
      hasRegression:
        /\*\*(?:Regression test|Tests?|Verify|Verified)(?::)?\*\*/i.test(body),
      regressionWaiver: regressionWaiver?.[1]?.trim() ?? "",
      headingHasStatus: STATUS_MARKER.test(rawHeading),
    };
  });
}

export function buildBugIndex(entries, policyFrom) {
  const statusCounts = {};
  for (const entry of entries) {
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    source: "docs/BUG-HISTORY.md",
    policyFrom,
    entryCount: entries.length,
    statusCounts,
    entries: entries.map(
      ({
        id,
        date,
        title,
        categories,
        category,
        status,
        statusIcon,
        statusDate,
        tests,
        commits,
        hasRootCause,
        hasFix,
        hasRegression,
        regressionWaiver,
      }) => ({
        id,
        date,
        title,
        categories,
        category,
        status,
        statusIcon,
        statusDate,
        tests,
        commits,
        hasRootCause,
        hasFix,
        hasRegression,
        regressionWaiver,
      }),
    ),
  };
}

export function searchBugHistory(entries, query, limit = 20) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return entries
    .map((entry) => {
      const id = entry.id.toLowerCase();
      const title = entry.title.toLowerCase();
      const categories = entry.categories.join(" ").toLowerCase();
      const tests = entry.tests.join(" ").toLowerCase();
      const body = entry.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (id.includes(term)) score += 20;
        if (title.includes(term)) score += 8;
        if (categories.includes(term)) score += 5;
        if (tests.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      return { entry, score };
    })
    .filter(({ score }) => score >= terms.length)
    .sort((a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date))
    .slice(0, limit)
    .map(({ entry }) => entry);
}
