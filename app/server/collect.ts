// 화면 없이 실시간 수집만 돌릴 때: npm run collect
import { startCollector } from './collector.ts';

startCollector();
// startCollector 의 타이머는 unref 되어 있으므로 프로세스를 붙잡아 둔다.
setInterval(() => {}, 1 << 30);
