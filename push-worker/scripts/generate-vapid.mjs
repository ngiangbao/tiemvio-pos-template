// Generates the VAPID key pair used to sign push messages.
//   node push-worker/scripts/generate-vapid.mjs
// The PUBLIC key goes into web/src/push-config.js and wrangler.toml; the PRIVATE key is a secret:
//   npx wrangler secret put VAPID_PRIVATE_KEY
import {generateKeyPairSync} from 'node:crypto';
const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
const jwk = privateKey.export({format: 'jwk'});
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
console.log(JSON.stringify({VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: jwk.d}));
