export function assertTenantScope(sessionTenantId:string|undefined, requestedTenantId:string){if(!sessionTenantId||sessionTenantId!==requestedTenantId) throw new Error('TENANT_SCOPE_VIOLATION');}
export function canViewAllTenants(role:string){return role==='SUPER_ADMIN'}
