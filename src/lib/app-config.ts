/**
 * App-level constants that must not be scattered as string literals across
 * components. Client-specific values (store name, branding, palettes) move into
 * the typed StoreProfile in M1 — this only removes the hardcoded storage
 * namespace from the demo store so the profile can own it later.
 */
export const BROWSER_STORAGE_NAMESPACE = 'axima-commerce'
