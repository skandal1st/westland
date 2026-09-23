import { build } from 'esbuild';
await build({ entryPoints: { 'catalog-hierarchy': 'scripts/catalog-hierarchy.ts', 'integration-worker': 'scripts/integration-worker.ts', 'legacy-ownership': 'scripts/legacy-ownership.ts', 'enterprisedata-http-probe': 'scripts/enterprisedata-http-probe.ts' }, outdir: 'dist', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['@prisma/client'],
  tsconfig: 'tsconfig.json', logLevel: 'info' });
