import { rmSync } from 'node:fs';

// Isolated database for the suite. Must be set before any server module is
// imported: config and the PGlite driver read the environment on first import.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'pglite://.data-test';
process.env.AUTO_SEED = 'false';
process.env.WORKER_ENABLED = 'false';
process.env.APP_ORIGIN = 'http://localhost:3000';
process.env.MASTER_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

rmSync('.data-test', { recursive: true, force: true });
