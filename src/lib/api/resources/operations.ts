// ---------------------------------------------------------------------------
// Equipment, maintenance logs, consignments, BOM templates, R&D projects.
// Operations / engineering domain.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { RdProjectSchema } from "../../schemas";
import { makeCrud } from "./_crud";

const EquipmentSchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    name: z.string(),
    departmentCode: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const MaintenanceLogSchema = z
  .object({
    id: z.string(),
    equipmentId: z.string().optional(),
    performedAt: z.string().optional(),
    type: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const ConsignmentSchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    customerId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const BomTemplateSchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    name: z.string().optional(),
    category: z.string().optional(),
  })
  .passthrough();

export const equipment = makeCrud({
  base: "/api/equipment",
  schema: EquipmentSchema,
  bucket: "master",
});

export const maintenance = makeCrud({
  base: "/api/maintenance-logs",
  schema: MaintenanceLogSchema,
  bucket: "transactional",
});

export const rdProjects = makeCrud({
  base: "/api/rd-projects",
  schema: RdProjectSchema,
  bucket: "master",
});

export const consignments = makeCrud({
  base: "/api/consignments",
  schema: ConsignmentSchema,
  bucket: "transactional",
});

export const bomTemplates = makeCrud({
  base: "/api/bom-master-templates",
  schema: BomTemplateSchema,
  bucket: "reference",
});
