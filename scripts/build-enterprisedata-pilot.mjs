import { build } from 'esbuild'
await build({ entryPoints: ['scripts/enterprisedata-pilot.ts'], outfile: 'dist/enterprisedata-pilot.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external' })

await build({ entryPoints: ['scripts/enterprisedata-http-probe.ts'], outfile: 'dist/enterprisedata-http-probe.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external' })

await build({ entryPoints: ['scripts/review-enterprisedata-sample.ts'], outfile: 'dist/review-enterprisedata-sample.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external' })

await build({ entryPoints: ['scripts/queue-enterprisedata-test-order.ts'], outfile: 'dist/queue-enterprisedata-test-order.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs', packages: 'external' })
