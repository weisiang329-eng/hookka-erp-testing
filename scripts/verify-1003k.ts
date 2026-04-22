const PROD = "https://hookka-erp-testing.pages.dev";
async function main() {
  const r = await fetch(PROD + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "weisiang329@gmail.com",
      password: "CbpxqJQpjy3VA5yd3Q",
    }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  const token = j.data?.token;
  if (!token) throw new Error("login failed");
  const t = await fetch(PROD + "/api/bom/templates", {
    headers: { authorization: "Bearer " + token },
  });
  const tj = (await t.json()) as { data?: Array<Record<string, unknown>> };
  const tpl = (tj.data ?? []).find((x) => x.productCode === "1003-(K)");
  if (!tpl) {
    console.log("NOT FOUND");
    return;
  }
  const tree = Array.isArray(tpl.wipComponents)
    ? (tpl.wipComponents as Array<Record<string, unknown>>)
    : (JSON.parse(String(tpl.wipComponents)) as Array<Record<string, unknown>>);
  const dump = (n: Record<string, unknown>, d: number) => {
    const ind = "  ".repeat(d);
    console.log(
      ind + (n.wipCode ?? "?") + " (" + (n.wipType ?? "?") + ")",
    );
    for (const p of (n.processes as Array<Record<string, unknown>>) ?? [])
      console.log(
        ind + "  " + p.deptCode + " " + p.category + " " + p.minutes + "m",
      );
    for (const k of (n.children as Array<Record<string, unknown>>) ?? [])
      dump(k, d + 1);
  };
  console.log("=== 1003-(K) CURRENT ===");
  for (const top of tree) dump(top, 0);
}
main().catch((e) => console.error(e));
