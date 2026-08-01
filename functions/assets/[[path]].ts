// ---------------------------------------------------------------------------
// functions/assets/[[path]].ts — a build asset that does not exist must 404,
// not hand back the app shell with a one-year immutable cache header.
//
// Measured on prod 2026-08-02:
//
//   GET /assets/not-real-xyz123.js
//   → HTTP 200
//     content-type:  text/html; charset=utf-8          ← the SPA shell
//     cache-control: public, max-age=31536000, immutable
//
// Cloudflare Pages' SPA fallback answers ANY unmatched path with index.html so
// deep links work (`/sales/so-xxx` must load the app). That is correct for
// routes and wrong for `/assets/*`: the shell gets served under a hashed chunk
// URL, and `public/_headers` then tells the browser to keep it for a YEAR,
// immutably. The browser has an HTML document where a JS module should be, and
// no revalidation will ever fix it.
//
// Ported from Houzs-ERP #1448 ("a missing asset must 404, not return the app
// shell at 200"), which hit exactly this with a 4-hour TTL — ours is 31536000.
//
// SCOPE IS THE SAFETY. This lives at `functions/assets/` so it can only ever
// match `/assets/*`. A root `functions/[[path]].ts` catch-all would sit in
// front of `/api/*` and every deep link, which is not a bet worth taking on a
// live ERP.
//
// `immutable` STAYS on real assets: they are content-hashed, which is exactly
// what the header is for. Once a missing one 404s, the shell can no longer be
// cached under an asset URL, so the hazard the header amplified is gone.
// ---------------------------------------------------------------------------

/** Extensions Vite emits into /assets. A shell served for any of these is a miss. */
const ASSET_EXT =
  /\.(js|mjs|cjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|wasm|json|txt)$/i;

export const onRequest: PagesFunction = async (ctx) => {
  const res = await ctx.next();

  const url = new URL(ctx.request.url);
  // Only a path that LOOKS like a build asset is eligible — never guess at a
  // path we don't recognise.
  if (!ASSET_EXT.test(url.pathname)) return res;

  const type = res.headers.get("content-type") ?? "";
  // A real asset never comes back as HTML. If it did, the SPA fallback answered
  // and the file is not in this deployment.
  if (res.status !== 200 || !type.toLowerCase().includes("text/html")) return res;

  return new Response(`Not found: ${url.pathname}\n`, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // The 404 itself must never be cached: the very next deploy may well
      // publish this exact filename.
      "cache-control": "no-store",
      "x-asset-miss": "1",
    },
  });
};
