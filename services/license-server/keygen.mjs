import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const output = path.resolve(process.argv[2] || 'services/license-server/keys');
const privateFile = path.join(output, 'publisher-private.pem');
const publicFile = path.join(output, 'publisher-public.pem');
if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error(`Refusing to overwrite keys in ${output}`);
fs.mkdirSync(output, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
fs.writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
console.log(`Publisher keys created. Protect ${privateFile}; distribute only ${publicFile}.`);

