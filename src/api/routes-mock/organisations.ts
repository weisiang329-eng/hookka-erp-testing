import { Hono } from 'hono';
import { organisations, activeOrgId, setActiveOrgId, interCompanyConfig } from '../../lib/mock-data';

const app = new Hono();

// GET /api/organisations
app.get('/', (c) => c.json({ organisations, activeOrgId, interCompanyConfig }));

// PUT /api/organisations
app.put('/', async (c) => {
  const body = await c.req.json();

  if (body.orgId) {
    const org = organisations.find((o) => o.id === body.orgId);
    if (!org) return c.json({ error: 'Organisation not found' }, 404);
    setActiveOrgId(body.orgId);
    return c.json({ activeOrgId: body.orgId, organisation: org });
  }

  if (body.organisation) {
    const idx = organisations.findIndex((o) => o.id === body.organisation.id);
    if (idx === -1) return c.json({ error: 'Organisation not found' }, 404);
    Object.assign(organisations[idx], body.organisation);
    return c.json({ organisation: organisations[idx] });
  }

  if (body.interCompanyConfig) {
    Object.assign(interCompanyConfig, body.interCompanyConfig);
    return c.json({ interCompanyConfig });
  }

  return c.json({ error: 'Invalid request body' }, 400);
});

export default app;
