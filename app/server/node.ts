// 운영용 단일 서버: 빌드된 화면(dist) + API + 실시간 수집기
// 사용: npm run build && npm run serve
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { api } from './app.ts';
import { startCollector } from './collector.ts';

const app = new Hono();
app.route('/', api);
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`길막닥터 http://localhost:${port}`));
startCollector();
