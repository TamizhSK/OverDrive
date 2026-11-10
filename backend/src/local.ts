import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { memoryRepository } from './tickets/repository.ts';

const repository = memoryRepository();
const app = createApp(repository, true);
await app.request('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Infotainment display restarting', description: 'The display restarted twice on my last journey. Please arrange a review.' }) });
await app.request('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Upcoming maintenance appointment', description: 'I would like to book the next scheduled service for my vehicle.' }) });
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3001) }, info => console.log(`ServiceCare demo API: http://localhost:${info.port}`));