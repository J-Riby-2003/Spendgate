import './config.js';
import { createApplication } from './app.js';
const port = Number(process.env.TOLLKEEP_PORT ?? 8787);
if (process.env.NODE_ENV === 'production' && !process.env.TOLLKEEP_PUBLIC_BASE_URL?.startsWith('https://')) {
  throw new Error('Production requires TOLLKEEP_PUBLIC_BASE_URL with an HTTPS origin');
}
createApplication().listen(port, () => {
  console.log(`Tollkeep server on port ${port}; operator sessions and scoped agent credentials required.`);
});
