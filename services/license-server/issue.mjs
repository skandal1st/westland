import path from 'node:path';
import { createLicense, readStore, writeStore } from './lib.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const dataFile = path.resolve(args.get('--data') || 'services/license-server/data/licenses.json');
const customerId = args.get('--customer');
const modules = (args.get('--modules') || '').split(',').map((item) => item.trim()).filter(Boolean);
const productionSeats = Number(args.get('--production-seats') || 1);
const stagingSeats = Number(args.get('--staging-seats') || 0);
if (!customerId || modules.length === 0) throw new Error('Usage: npm run license:issue -- --customer <id> --modules <a,b> [--production-seats 1] [--staging-seats 0]');
if (!Number.isInteger(productionSeats) || !Number.isInteger(stagingSeats) || productionSeats < 0 || stagingSeats < 0) throw new Error('Seat counts must be non-negative integers');
const store = readStore(dataFile);
const { activationKey, record } = createLicense({ customerId, modules, productionSeats, stagingSeats });
store.licenses.push(record);
writeStore(dataFile, store);
console.log(`License ${record.licenseId} created for ${customerId}.`);
console.log('Activation key (shown once):');
console.log(activationKey);

