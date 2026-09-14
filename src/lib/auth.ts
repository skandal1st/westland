import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { getActiveStore } from '@/lib/store'

/**
 * Credentials auth for the closed B2B storefront. JWT sessions carry role,
 * status and store so authorization checks never re-query on every guard.
 * SUSPENDED users cannot obtain a session (checked in authorize).
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        const store = await getActiveStore()
        const email = credentials.email.trim().toLowerCase()
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
      if (session.user) {
        session.user.id = token.sub as string
        session.user.role = token.role
        session.user.status = token.status
        session.user.storeId = token.storeId
        session.user.customerId = token.customerId
        session.user.priceGroupId = token.priceGroupId
      }
      return session
    },
  },
}
