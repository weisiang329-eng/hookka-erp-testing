export type BugEntry = {
  id: string;
  date: string;
  title: string;
  status: string;
  statusIcon: string;
  statusDate: string;
  category: string;
  categories: string[];
  tests: string[];
  commits: string[];
  hasRootCause: boolean;
  hasFix: boolean;
  hasRegression: boolean;
  regressionWaiver: string;
};

export function topCategories(
  entries: BugEntry[],
  limit = 10,
): Array<{ category: string; n: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const categories = entry.categories.length > 0
      ? entry.categories
      : [entry.category];
    for (const category of categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category))
    .slice(0, limit);
}
