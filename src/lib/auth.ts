import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { getActiveStore } from '@/lib/store'
import { clientIp, loginRateLimit } from '@/lib/rate-limit'

/**
 * Credentials auth for the closed B2B storefront. JWT identifies the login;
 * current database state is authoritative on every session read, including
 * API/page guards and the client session endpoint.
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null
        const email = credentials.email.trim().toLowerCase()
        if (!loginRateLimit(clientIp(new Headers(request.headers)), email).ok) return null
        const store = await getActiveStore()
        const user = await prisma.user.findUnique({
          where: { storeId_email: { storeId: store.id, email } },
        })
        if (!user || user.status !== 'ACTIVE') return null
        const ok = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!ok) return null
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          storeId: user.storeId,
          customerId: user.customerId,
          priceGroupId: user.priceGroupId,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role
        token.status = user.status
        token.storeId = user.storeId
        token.customerId = user.customerId
        token.priceGroupId = user.priceGroupId
      }
      return token
    },
    async session({ session, token }) {
      if (!token.sub || !token.storeId) throw new Error('Session access revoked')
      const user = await prisma.user.findUnique({
        where: { id: token.sub },
        select: { id: true, email: true, name: true, role: true, status: true, storeId: true, customerId: true, priceGroupId: true },
      })
      // NextAuth v4 clears the session cookie and returns no session on error.
      // Never fall back to JWT claims on a missing/inactive user or DB failure.
      if (!user || user.status !== 'ACTIVE' || user.storeId !== token.storeId) {
        throw new Error('Session access revoked')
      }
      session.user = user
      return session
    },
  },
}
