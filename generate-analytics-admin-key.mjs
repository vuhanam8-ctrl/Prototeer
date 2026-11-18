import {createHash,randomBytes} from 'node:crypto';

const adminKey=randomBytes(32).toString('base64url');
const digest=createHash('sha256').update(adminKey,'utf8').digest('hex');

console.log('Analytics admin key — keep this private and do not commit it:');
console.log(adminKey);
console.log('\nSet this digest in the Convex deployment environment:');
console.log(`PROTOTEER_ANALYTICS_ADMIN_SHA256=${digest}`);
