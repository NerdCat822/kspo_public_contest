import { getRequestListener } from '@hono/node-server';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';
import { api } from './server/app.ts';
import { startCollector } from './server/collector.ts';

/** 개발 서버와 preview 서버에 /api 를 붙인다. 키는 서버에서만 쓰이고 브라우저로 나가지 않는다. */
function gilmakApi(): Plugin {
  const listener = getRequestListener(api.fetch);
  const mount = (middlewares: Connect.Server) =>
    middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/api/')) {
        void listener(req, res);
        return;
      }
      next();
    });
  return {
    name: 'gilmak-api',
    configureServer(server) {
      mount(server.middlewares);
      startCollector((m) => server.config.logger.info(m, { timestamp: true }));
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
      startCollector((m) => server.config.logger.info(m, { timestamp: true }));
    },
  };
}

export default defineConfig({
  plugins: [react(), gilmakApi()],
  server: { port: 5173 },
});
