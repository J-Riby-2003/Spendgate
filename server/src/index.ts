import './config.js';
import { createApplication } from './app.js';
const port = Number(process.env.SPENDLOCK_PORT ?? 8787);
if (process.env.NODE_ENV === 'production' && !process.env.SPENDLOCK_PUBLIC_BASE_URL?.startsWith('https://')) {
  throw new Error('Production requires SPENDLOCK_PUBLIC_BASE_URL with an HTTPS origin');
}
createApplication().listen(port, () => {
  console.log(`SpendLock server on port ${port}; operator sessions and scoped agent credentials required.`);
});
