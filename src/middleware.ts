import { withAuth } from 'next-auth/middleware'

/** Redirect UX only. API/page guards validate current DB authority via session. */
export default withAuth({
  callbacks: { authorized: ({ token }) => !!token },
  pages: { signIn: '/login' },
})

export const config = {
  matcher: ['/catalog/:path*', '/account/:path*', '/checkout/:path*', '/staff/:path*'],
}
