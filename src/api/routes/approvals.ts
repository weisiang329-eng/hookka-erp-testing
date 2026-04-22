import { Hono } from 'hono';
import { approvalRequests, generateId } from '../../lib/mock-data';
import type { ApprovalRequest } from '../../lib/mock-data';

const app = new Hono();

// GET /api/approvals?status=PENDING&type=PRICE_OVERRIDE
app.get('/', (c) => {
  const status = c.req.query('status');
  const type = c.req.query('type');

  let filtered = [...approvalRequests];
  if (status) filtered = filtered.filter((a) => a.status === status);
  if (type) filtered = filtered.filter((a) => a.type === type);

  filtered.sort(
    (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
  );

  return c.json(filtered);
});

// POST /api/approvals
app.post('/', async (c) => {
  const body = await c.req.json();
  const { type, referenceNo, referenceId, title, description, requestedBy, amountSen, metadata } =
    body as Partial<ApprovalRequest>;

  if (!type || !referenceNo || !referenceId || !title || !description || !requestedBy) {
    return c.json(
      { error: 'Missing required fields: type, referenceNo, referenceId, title, description, requestedBy' },
      400
    );
  }

  const newApproval: ApprovalRequest = {
    id: generateId(),
    type,
    referenceNo,
    referenceId,
    title,
    description,
    requestedBy,
    requestedAt: new Date().toISOString(),
    status: 'PENDING',
    amountSen,
    metadata,
  };

  approvalRequests.push(newApproval);
  return c.json(newApproval, 201);
});

// PUT /api/approvals
app.put('/', async (c) => {
  const body = await c.req.json();
  const { id, action, reason } = body as { id: string; action: 'APPROVE' | 'REJECT'; reason?: string };

  if (!id || !action) {
    return c.json({ error: 'Missing required fields: id, action' }, 400);
  }
  if (action !== 'APPROVE' && action !== 'REJECT') {
    return c.json({ error: 'action must be "APPROVE" or "REJECT"' }, 400);
  }
  if (action === 'REJECT' && !reason) {
    return c.json({ error: 'Reason is required when rejecting' }, 400);
  }

  const approval = approvalRequests.find((a) => a.id === id);
  if (!approval) return c.json({ error: 'Approval not found' }, 404);

  if (approval.status !== 'PENDING') {
    return c.json({ error: `Approval already ${approval.status.toLowerCase()}` }, 400);
  }

  approval.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  approval.approvedBy = 'Encik Hakimi';
  approval.approvedAt = new Date().toISOString();
  if (reason) approval.reason = reason;

  return c.json(approval);
});

export default app;
