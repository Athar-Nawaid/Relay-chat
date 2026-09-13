import { useAuthStore } from '../store/authStore.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/**
 * A single in-flight refresh, shared.
 *
 * Without this, a screen that fires several requests at once would kick off
 * several refreshes in parallel — and because refresh tokens rotate, the second
 * one would present a token the first had already burned, tripping reuse
 * detection and logging the user out for doing nothing wrong.
 */
let refreshInFlight = null;

async function refreshAccessToken() {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) return null;

      const data = await res.json();
      useAuthStore.getState().setSession(data);
      return data.accessToken;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function raw(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return res;
}

/**
 * Authenticated request. On a 401 it refreshes once and retries — so a token
 * expiring mid-session is invisible to the user rather than an error they see.
 */
export async function api(path, options = {}) {
  const { accessToken } = useAuthStore.getState();

  let res = await raw(path, { ...options, token: accessToken });

  if (res.status === 401 && !options.noRetry) {
    const fresh = await refreshAccessToken();
    if (!fresh) {
      useAuthStore.getState().clear();
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired');
    }
    res = await raw(path, { ...options, token: fresh });
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message);
  }
  return data;
}

export const auth = {
  login: (username, password) =>
    api('/api/auth/login', { method: 'POST', body: { username, password }, noRetry: true }),
  register: (username, password, displayName) =>
    api('/api/auth/register', {
      method: 'POST',
      body: { username, password, displayName },
      noRetry: true,
    }),
  logout: () => api('/api/auth/logout', { method: 'POST', noRetry: true }),
  refresh: refreshAccessToken,
};

export const conversations = {
  list: () => api('/api/conversations'),
  createDm: (userId) => api('/api/conversations', { method: 'POST', body: { type: 'dm', userId } }),
  createGroup: (title, memberIds) =>
    api('/api/conversations', { method: 'POST', body: { type: 'group', title, memberIds } }),
  history: (id, { beforeSeq, limit = 50 } = {}) =>
    api(
      `/api/conversations/${id}/messages?limit=${limit}${
        beforeSeq ? `&beforeSeq=${beforeSeq}` : ''
      }`,
    ),
  range: (id, afterSeq, beforeSeq) =>
    api(`/api/conversations/${id}/messages?afterSeq=${afterSeq}&beforeSeq=${beforeSeq}`),
};

export const users = {
  search: (q) => api(`/api/users?q=${encodeURIComponent(q)}`),
};
