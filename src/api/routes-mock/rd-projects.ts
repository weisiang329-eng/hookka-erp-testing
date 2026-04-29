import { Hono } from 'hono';
import { rdProjects, rawMaterials, generateId } from '../../lib/mock-data';
import type { RDProject, RDProjectStage, RDMaterialIssuance, RDLabourLog } from '../../lib/mock-data';

const app = new Hono();

// GET /api/rd-projects
app.get('/', (c) => {
  const status = c.req.query('status');
  const stage = c.req.query('stage');

  let filtered = [...rdProjects];
  if (status) filtered = filtered.filter((p) => p.status === status);
  if (stage) filtered = filtered.filter((p) => p.currentStage === stage);

  return c.json({ success: true, data: filtered });
});

// POST /api/rd-projects
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { name, productCategory } = body;
    if (!name || !productCategory) {
      return c.json({ success: false, error: 'name and productCategory are required' }, 400);
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const seq = String(rdProjects.length + 1).padStart(3, '0');
    const code = `RD-${yy}${mm}-${seq}`;

    const stages: RDProjectStage[] = ['CONCEPT', 'DESIGN', 'PROTOTYPE', 'TESTING', 'APPROVED', 'PRODUCTION_READY'];

    const newProject: RDProject = {
      id: generateId(),
      code,
      name,
      description: body.description ?? '',
      projectType: body.projectType ?? 'DEVELOPMENT',
      productCategory,
      serviceId: body.serviceId ?? undefined,
      currentStage: 'CONCEPT',
      targetLaunchDate: body.targetLaunchDate ?? '',
      assignedTeam: body.assignedTeam ?? [],
      milestones: stages.map((stage) => ({
        stage,
        targetDate: '',
        actualDate: null,
        approvedBy: null,
      })),
      totalBudget: body.totalBudget ?? 0,
      actualCost: 0,
      prototypes: [],
      materialIssuances: [],
      labourLogs: [],
      sourceProductName: body.sourceProductName ?? undefined,
      sourceBrand: body.sourceBrand ?? undefined,
      sourcePurchaseRef: body.sourcePurchaseRef ?? undefined,
      sourceNotes: body.sourceNotes ?? undefined,
      coverPhotoUrl: body.coverPhotoUrl ?? null,
      createdDate: now.toISOString(),
      status: 'ACTIVE',
    };

    rdProjects.push(newProject);
    return c.json({ success: true, data: newProject }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/rd-projects/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const project = rdProjects.find((p) => p.id === id);
  if (!project) return c.json({ success: false, error: 'R&D project not found' }, 404);
  return c.json({ success: true, data: project });
});

// PUT /api/rd-projects/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = rdProjects.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'R&D project not found' }, 404);

  try {
    const body = await c.req.json();
    const existing = rdProjects[idx];

    // Reverse-cascade: detect deleted issuances and credit warehouse stock
    // in the mock raw_materials array. Mirrors src/api/routes/rd-projects.ts.
    if (Array.isArray(body.materialIssuances) && existing.materialIssuances) {
      const nextIds = new Set<string>(
        body.materialIssuances
          .map((i: { id?: string }) => i.id)
          .filter((x: string | undefined): x is string => typeof x === "string"),
      );
      for (const prev of existing.materialIssuances) {
        if (!nextIds.has(prev.id)) {
          const rm = rawMaterials.find((r) => r.id === prev.materialId);
          if (rm) rm.balanceQty += prev.qty;
        }
      }
    }

    const computedActualCost = Array.isArray(body.materialIssuances)
      ? body.materialIssuances.reduce(
          (sum: number, i: { totalCostSen?: number }) =>
            sum + (typeof i.totalCostSen === "number" ? i.totalCostSen : 0),
          0,
        )
      : undefined;

    const updated = {
      ...existing,
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      projectType: body.projectType ?? existing.projectType,
      serviceId: body.serviceId !== undefined ? body.serviceId : existing.serviceId,
      productCategory: body.productCategory ?? existing.productCategory,
      currentStage: body.currentStage ?? existing.currentStage,
      targetLaunchDate: body.targetLaunchDate ?? existing.targetLaunchDate,
      assignedTeam: body.assignedTeam ?? existing.assignedTeam,
      milestones: body.milestones ?? existing.milestones,
      totalBudget: body.totalBudget ?? existing.totalBudget,
      actualCost:
        body.actualCost !== undefined
          ? body.actualCost
          : computedActualCost !== undefined
          ? computedActualCost
          : existing.actualCost,
      prototypes: body.prototypes ?? existing.prototypes,
      productionBOM: body.productionBOM !== undefined ? body.productionBOM : existing.productionBOM,
      materialIssuances: body.materialIssuances !== undefined ? body.materialIssuances : existing.materialIssuances,
      labourLogs: body.labourLogs !== undefined ? body.labourLogs : existing.labourLogs,
      sourceProductName:
        body.sourceProductName !== undefined ? body.sourceProductName : existing.sourceProductName,
      sourceBrand: body.sourceBrand !== undefined ? body.sourceBrand : existing.sourceBrand,
      sourcePurchaseRef:
        body.sourcePurchaseRef !== undefined ? body.sourcePurchaseRef : existing.sourcePurchaseRef,
      sourceNotes: body.sourceNotes !== undefined ? body.sourceNotes : existing.sourceNotes,
      coverPhotoUrl:
        body.coverPhotoUrl !== undefined ? body.coverPhotoUrl : existing.coverPhotoUrl,
      status: body.status ?? existing.status,
    };

    rdProjects[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// POST /api/rd-projects/:id/issue-material — issue raw material, deduct from inventory
app.post('/:id/issue-material', async (c) => {
  const id = c.req.param('id');
  const idx = rdProjects.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'R&D project not found' }, 404);

  try {
    const body = await c.req.json();
    const { materialId, qty, issuedBy, notes } = body;
    if (!materialId || !qty || qty <= 0) {
      return c.json({ success: false, error: 'materialId and qty > 0 are required' }, 400);
    }

    // Find raw material
    const rm = rawMaterials.find((r) => r.id === materialId);
    if (!rm) return c.json({ success: false, error: 'Raw material not found' }, 404);

    if (rm.balanceQty < qty) {
      return c.json({ success: false, error: `Insufficient stock. Available: ${rm.balanceQty} ${rm.baseUOM}` }, 400);
    }

    // FIFO cost: use latest supplier price or fallback estimate
    // In real system this comes from purchase price FIFO queue
    // For mock: estimate based on item group
    const unitCostSen = body.unitCostSen ?? estimateFIFOCost(rm.itemCode, rm.itemGroup);

    // Deduct from inventory
    rm.balanceQty -= qty;

    const project = rdProjects[idx];
    const issuance: RDMaterialIssuance = {
      id: generateId(),
      rdProjectId: project.id,
      rdProjectCode: project.code,
      materialId: rm.id,
      materialCode: rm.itemCode,
      materialName: rm.description,
      qty,
      unit: rm.baseUOM,
      unitCostSen,
      totalCostSen: Math.round(unitCostSen * qty),
      issuedDate: new Date().toISOString().slice(0, 10),
      issuedBy: issuedBy ?? 'System',
      notes: notes ?? '',
    };

    if (!project.materialIssuances) project.materialIssuances = [];
    project.materialIssuances.push(issuance);

    // Update actual cost
    const totalMaterialCost = project.materialIssuances.reduce((sum, i) => sum + i.totalCostSen, 0);
    project.actualCost = totalMaterialCost;

    return c.json({ success: true, data: { issuance, project } });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// POST /api/rd-projects/:id/labour-log — add labour hours
app.post('/:id/labour-log', async (c) => {
  const id = c.req.param('id');
  const idx = rdProjects.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'R&D project not found' }, 404);

  try {
    const body = await c.req.json();
    const { workerName, hours, date, description, department } = body;
    if (!workerName || !hours || hours <= 0 || !date) {
      return c.json({ success: false, error: 'workerName, hours > 0, and date are required' }, 400);
    }

    const project = rdProjects[idx];
    const log: RDLabourLog = {
      id: generateId(),
      rdProjectId: project.id,
      workerName,
      department: department ?? 'R&D',
      hours,
      date,
      description: description ?? '',
    };

    if (!project.labourLogs) project.labourLogs = [];
    project.labourLogs.push(log);

    return c.json({ success: true, data: { log, project } });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// DELETE /api/rd-projects/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = rdProjects.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'R&D project not found' }, 404);
  const removed = rdProjects.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

// Helper: estimate FIFO cost based on item group (mock)
function estimateFIFOCost(itemCode: string, itemGroup: string): number {
  const groupCosts: Record<string, number> = {
    'PLYWOOD': 4500,
    'B.M-FABR': 2500,
    'S.M-FABR': 3000,
    'B.OTHERS': 800,
    'EQUIPMEN': 5000,
    'SPONGE': 1500,
  };
  return groupCosts[itemGroup] ?? 2000;
}

export default app;
