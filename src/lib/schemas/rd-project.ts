// ---------------------------------------------------------------------------
// R&D project schemas. Mirror src/api/routes/rd-projects.ts rowToProject.
// Many fields are JSON-parsed from TEXT columns and the SPA introspects them
// freely, so these are loose unknown[] arrays with passthrough.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const RdPrototypeSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    prototypeType: z.string().optional(),
    version: z.string(),
    description: z.string().optional(),
    materialsCost: z.number().optional(),
    labourHours: z.number().optional(),
    testResults: z.string().optional(),
    feedback: z.string().optional(),
    improvements: z.string().optional(),
    defects: z.string().optional(),
    createdDate: z.string().optional(),
  })
  .passthrough();

export const RdProjectSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string().optional(),
    projectType: z.string().optional(),
    productCategory: z.string().optional(),
    serviceId: z.string().optional(),
    currentStage: z.string().optional(),
    targetLaunchDate: z.string().optional(),
    assignedTeam: z.array(z.string()).optional(),
    totalBudget: z.number().optional(),
    actualCost: z.number().optional(),
    milestones: z.array(z.unknown()).optional(),
    productionBOM: z.array(z.unknown()).optional(),
    materialIssuances: z.array(z.unknown()).optional(),
    labourLogs: z.array(z.unknown()).optional(),
    sourceProductName: z.string().optional(),
    sourceBrand: z.string().optional(),
    sourcePurchaseRef: z.string().optional(),
    sourceNotes: z.string().optional(),
    coverPhotoUrl: z.string().nullable().optional(),
    prototypes: z.array(RdPrototypeSchema).optional(),
    createdDate: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export type RdProjectFromApi = z.infer<typeof RdProjectSchema>;
