// ---------------------------------------------------------------------------
// Re-export every domain schema so callers can `import { ... } from
// "@/lib/schemas"` without picking the right file.
// ---------------------------------------------------------------------------
export * from "./common";
export * from "./customer";
export * from "./delivery-order";
export * from "./product";
export * from "./production-order";
export * from "./sales-order";
export * from "./invoice";
export * from "./rd-project";
export * from "./worker-job";
