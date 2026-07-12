async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) throw Object.assign(new Error('Not signed in'), { code: 401 });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const api = {
  me: () => request('/me'),
  nas: () => request('/nas'),
  logout: () => request('/logout', { method: 'POST' }),
  guild: (id) => request(`/guilds/${id}`),
  live: (id) => request(`/guilds/${id}/live`),
  saveConfig: (id, body) => request(`/guilds/${id}/config`, { method: 'PUT', body }),
  addWatch: (id, body) => request(`/guilds/${id}/watches`, { method: 'POST', body }),
  removeWatch: (id, kind, value) =>
    request(`/guilds/${id}/watches/${kind}/${encodeURIComponent(value)}`, { method: 'DELETE' }),
};
