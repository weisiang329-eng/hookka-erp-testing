// ---------------------------------------------------------------------------
// D1-backed customer-hubs route.
//
// Read-only hierarchical customer-branch directory. The `children` column is
// stored as a JSON string[] and parsed back to an array before returning, so
// the SPA sees the same shape as the old in-memory route.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type CustomerHubRow = {
  id: string;
  parentId: string | null;
  creditorCode: string;
  name: string;
  shortName: string;
  state: string | null;
  pic: string | null;
  picContact: string | null;
  picEmail: string | null;
  deliveryAddress: string | null;
  isParent: number;
  children: string | null;
};

function parseChildren(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function rowToHub(row: CustomerHubRow) {
  const children = parseChildren(row.children);
  return {
    id: row.id,
    parentId: row.parentId,
    creditorCode: row.creditorCode,
    name: row.name,
    shortName: row.shortName,
    state: row.state ?? "",
    pic: row.pic ?? "",
    picContact: row.picContact ?? "",
    picEmail: row.picEmail ?? "",
    deliveryAddress: row.deliveryAddress ?? "",
    isParent: row.isParent === 1,
    ...(children !== undefined ? { children } : {}),
  };
}

// GET /api/customer-hubs?parentId=hub-houzs
app.get("/", async (c) => {
  const parentId = c.req.query("parentId");
  const stmt = parentId
    ? c.env.DB.prepare(
        "SELECT * FROM customer_hubs WHERE parentId = ? ORDER BY creditorCode",
      ).bind(parentId)
    : c.env.DB.prepare("SELECT * FROM customer_hubs ORDER BY creditorCode");
  const res = await stmt.all<CustomerHubRow>();
  const data = (res.results ?? []).map(rowToHub);
  return c.json({ success: true, data });
});

export default app;
