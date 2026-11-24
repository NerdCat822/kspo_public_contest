import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 화면은 /api 를 Go 백엔드(backend/)로 넘긴다. 키는 백엔드에만 있고 브라우저로 나가지 않는다.
 * 백엔드 주소를 바꾸려면 GILMAK_API=http://호스트:포트 npm run dev
 *
 * 파일과 API 를 모두 상대 경로(./assets, api/...)로 찾는다. 그래서 같은 빌드를 / 에도,
 * 게이트웨이의 하위 경로(https://hgkim-mini-pc.taild27e83.ts.net/gilmak-doctor/)에도 올릴 수 있다.
 */
const backend = process.env.GILMAK_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': backend } },
  preview: { proxy: { '/api': backend } },
});
