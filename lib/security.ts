import crypto from 'node:crypto';
export function hashToken(value:string){return crypto.createHash('sha256').update(value).digest('hex')}

// An environment override that is unset and one that is blank mean the same thing: fall back.
// `process.env.X ?? fallback` gets this wrong, because "" is a real value, not nullish, so a
// blanked-out variable silently disables the feature instead of using its default.
export function nonBlankEnv(value:string|undefined){return (value??'').trim()}
export function timingSafeEqualText(a:string,b:string){const A=Buffer.from(a);const B=Buffer.from(b);return A.length===B.length&&crypto.timingSafeEqual(A,B)}
export function requireSecureSecret(name:string,value:string|undefined,min=32){if(!value||value.length<min)throw new Error(`${name} is missing or too short`)}
