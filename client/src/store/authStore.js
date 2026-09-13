import { create } from 'zustand';

/**
 * The access token lives in memory only — never localStorage.
 *
 * XSS can still read it, but the blast radius is one tab for fifteen minutes
 * rather than a token sitting in storage where any later script or extension can
 * find it. Durability comes from the httpOnly refresh cookie instead, which
 * JavaScript cannot read at all: a page reload calls /refresh and gets a new
 * access token without the user logging in again.
 */
export const useAuthStore = create((set) => ({
  accessToken: null,
  user: null,
  status: 'loading', // loading | authenticated | anonymous

  setSession: ({ accessToken, user }) =>
    set({ accessToken, user, status: 'authenticated' }),

  clear: () => set({ accessToken: null, user: null, status: 'anonymous' }),

  setAnonymous: () => set({ accessToken: null, user: null, status: 'anonymous' }),
}));
