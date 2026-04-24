// Count items/SOs with gapInches / divanHeightInches across all SOs.
async function main() {
  const PROD = "https://hookka-erp-testing.pages.dev";
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "weisiang329@gmail.com", password: "CbpxqJQpjy3VA5yd3Q" }),
  });
  const { data: { token } } = await r.json() as any;
  const auth = { Authorization: `Bearer ${token}` };
  const sosRes = await fetch(`${PROD}/api/sales-orders`, { headers: auth });
  const sosJson = await sosRes.json() as any;
  console.log(`Total SOs in D1: ${sosJson.data.length}`);

  let totalSF = 0, totalBF = 0, sfWithGap = 0, bfWithGap = 0, sfWithDivan = 0, bfWithDivan = 0;
  const sosSfWithGap = new Set<string>(), sosBfWithGap = new Set<string>(), sosWithDivan = new Set<string>();
  for (const so of sosJson.data) {
    const detail = await (await fetch(`${PROD}/api/sales-orders/${so.id}`, { headers: auth })).json() as any;
    for (const item of (detail.data?.items || [])) {
      if (item.itemCategory === "SOFA") {
        totalSF++;
        if (item.gapInches != null) { sfWithGap++; sosSfWithGap.add(so.id); }
        if (item.divanHeightInches != null) { sfWithDivan++; sosWithDivan.add(so.id); }
      } else if (item.itemCategory === "BEDFRAME") {
        totalBF++;
        if (item.gapInches != null) { bfWithGap++; sosBfWithGap.add(so.id); }
        if (item.divanHeightInches != null) { bfWithDivan++; sosWithDivan.add(so.id); }
      }
    }
  }
  console.log(`BF items: ${totalBF}, with gap: ${bfWithGap}, with divan: ${bfWithDivan}`);
  console.log(`SF items: ${totalSF}, with gap: ${sfWithGap}, with divan: ${sfWithDivan}`);
  console.log(`BF SOs with gap: ${sosBfWithGap.size}`);
  console.log(`SF SOs with gap: ${sosSfWithGap.size}`);
  console.log(`SOs with divan: ${sosWithDivan.size}`);
}
main().catch(e => console.error(e));
