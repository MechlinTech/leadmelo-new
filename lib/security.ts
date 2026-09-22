import crypto from 'node:crypto';
export function hashToken(value:string){return crypto.createHash('sha256').update(value).digest('hex')}
export function timingSafeEqualText(a:string,b:string){const A=Buffer.from(a);const B=Buffer.from(b);return A.length===B.length&&crypto.timingSafeEqual(A,B)}
export function requireSecureSecret(name:string,value:string|undefined,min=32){if(!value||value.length<min)throw new Error(`${name} is missing or too short`)}
