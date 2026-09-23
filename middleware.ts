import { NextRequest, NextResponse } from 'next/server';

const sessionCookie = 'leadmelo_session';

function withCsp(request: NextRequest, response: NextResponse) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  return { headers, response };
}

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const needsSession = path === '/app' || path.startsWith('/app/') || path === '/admin' || path.startsWith('/admin/');
  if (needsSession && !request.cookies.get(sessionCookie)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/signin';
    url.search = '';
    const redirect = NextResponse.redirect(url);
    withCsp(request, redirect);
    return redirect;
  }
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export const config = { matcher: ['/((?!api|_next/static|_next/image|icons|leadmelo.css|manifest.webmanifest|sw.js).*)'] };
