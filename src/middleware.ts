import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

/**
 * Redirect UX + coarse protection at the edge. Authoritative, policy-aware
 * enforcement lives server-side (catalog API + page guards); this keeps
 * unauthenticated users out of authenticated areas and restricts the back
 * office to staff/admin.
 */
export default withAuth(
  function middleware(request) {
    const { token } = request.nextauth
    if (request.nextUrl.pathname.startsWith('/staff')) {
      if (token?.role !== 'STAFF' && token?.role !== 'ADMIN') {
        return NextResponse.redirect(new URL('/', request.url))
      }
    }
    return NextResponse.next()
  },
  {
    callbacks: { authorized: ({ token }) => !!token },
    pages: { signIn: '/login' },
  },
)

export const config = {
  matcher: ['/catalog/:path*', '/account/:path*', '/checkout/:path*', '/staff/:path*'],
}
