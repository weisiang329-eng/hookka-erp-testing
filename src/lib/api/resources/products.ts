// ---------------------------------------------------------------------------
// products — CRUD over /api/products. Master data; 15s SWR.
// ---------------------------------------------------------------------------
import { ProductSchema } from "../../schemas";
import { makeCrud } from "./_crud";

export const products = makeCrud({
  base: "/api/products",
  schema: ProductSchema,
  bucket: "master",
});
