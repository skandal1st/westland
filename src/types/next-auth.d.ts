import type { UserRole, UserStatus } from '@prisma/client'
import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      role: UserRole
      status: UserStatus
      storeId: string
      customerId: string | null
      priceGroupId: string | null
    }
  }

  interface User {
    id: string
    role: UserRole
    status: UserStatus
    storeId: string
    customerId: string | null
    priceGroupId: string | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role: UserRole
    status: UserStatus
    storeId: string
    customerId: string | null
    priceGroupId: string | null
  }
}
