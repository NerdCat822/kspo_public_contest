import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 화면은 /api 를 Go 백엔드(backend/)로 넘긴다. 키는 백엔드에만 있고 브라우저로 나가지 않는다.
 * 백엔드 주소를 바꾸려면 GILMAK_API=http://호스트:포트 npm run dev
 */
const backend = process.env.GILMAK_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': backend } },
  preview: { proxy: { '/api': backend } },
});
