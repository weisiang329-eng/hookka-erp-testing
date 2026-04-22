import { Hono } from 'hono';
import { equipmentList, maintenanceLogs, generateId } from '../../lib/mock-data';
import type { Equipment, MaintenanceLog } from '../../lib/mock-data';

const app = new Hono();

// GET /api/equipment
app.get('/', (c) => c.json({ success: true, data: equipmentList, total: equipmentList.length }));

// POST /api/equipment
app.post('/', async (c) => {
  const body = await c.req.json();

  const newEquipment: Equipment = {
    id: generateId(),
    code: body.code || '',
    name: body.name || '',
    department: body.department || '',
    type: body.type || 'OTHER',
    status: body.status || 'OPERATIONAL',
    lastMaintenanceDate: body.lastMaintenanceDate || new Date().toISOString().split('T')[0],
    nextMaintenanceDate: body.nextMaintenanceDate || '',
    maintenanceCycleDays: Number(body.maintenanceCycleDays) || 30,
    purchaseDate: body.purchaseDate || new Date().toISOString().split('T')[0],
    notes: body.notes || '',
  };

  equipmentList.push(newEquipment);
  return c.json({ success: true, data: newEquipment }, 201);
});

// GET /api/equipment/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const equipment = equipmentList.find((eq) => eq.id === id);
  if (!equipment) return c.json({ success: false, error: 'Equipment not found' }, 404);

  const logs = maintenanceLogs.filter((ml) => ml.equipmentId === id);
  return c.json({ success: true, data: { ...equipment, logs } });
});

// PUT /api/equipment/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = equipmentList.findIndex((eq) => eq.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Equipment not found' }, 404);

  const body = await c.req.json();

  // Maintenance log submission
  if (body.logMaintenance) {
    const log: MaintenanceLog = {
      id: generateId(),
      equipmentId: id,
      equipmentName: equipmentList[idx].name,
      type: body.logMaintenance.type || 'PREVENTIVE',
      description: body.logMaintenance.description || '',
      performedBy: body.logMaintenance.performedBy || '',
      date: body.logMaintenance.date || new Date().toISOString().split('T')[0],
      costSen: Number(body.logMaintenance.costSen) || 0,
      downtimeHours: Number(body.logMaintenance.downtimeHours) || 0,
    };
    maintenanceLogs.unshift(log);

    const today = new Date().toISOString().split('T')[0];
    equipmentList[idx].lastMaintenanceDate = log.date || today;
    const nextDate = new Date(log.date || today);
    nextDate.setDate(nextDate.getDate() + equipmentList[idx].maintenanceCycleDays);
    equipmentList[idx].nextMaintenanceDate = nextDate.toISOString().split('T')[0];
    if (equipmentList[idx].status === 'MAINTENANCE' || equipmentList[idx].status === 'REPAIR') {
      equipmentList[idx].status = 'OPERATIONAL';
    }

    return c.json({ success: true, data: equipmentList[idx], log });
  }

  // Regular update
  Object.assign(equipmentList[idx], {
    ...(body.code && { code: body.code }),
    ...(body.name && { name: body.name }),
    ...(body.department && { department: body.department }),
    ...(body.type && { type: body.type }),
    ...(body.status && { status: body.status }),
    ...(body.lastMaintenanceDate && { lastMaintenanceDate: body.lastMaintenanceDate }),
    ...(body.nextMaintenanceDate && { nextMaintenanceDate: body.nextMaintenanceDate }),
    ...(body.maintenanceCycleDays && { maintenanceCycleDays: body.maintenanceCycleDays }),
    ...(body.notes !== undefined && { notes: body.notes }),
  });

  return c.json({ success: true, data: equipmentList[idx] });
});

export default app;
