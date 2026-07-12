import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { config, OAUTH_REDIRECT_PATH } from '../config.js';
import * as db from '../db.js';

const COOKIE = 'rc_session';
const STATE_COOKIE = 'rc_oauth_state';
const redirectUri = () => `${config.web.baseUrl}${OAUTH_REDIRECT_PATH}`;
const secure = () => config.web.baseUrl.startsWith('https://');

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, value]) => name && value)
      .map(([name, ...rest]) => [name, decodeURIComponent(rest.join('='))]),
  );
}

function setCookie(res, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function loginUrl(res) {
  const state = randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, state, 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export async function completeLogin(req, res) {
  const { code, state } = req.query;
  const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);

  if (!code || !state || state !== expected) throw new Error('Invalid OAuth state');

  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.web.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  const { access_token: accessToken } = await tokenResponse.json();

  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) throw new Error(`Fetching the user failed: ${userResponse.status}`);
  const user = await userResponse.json();

  // The OAuth token is not stored: every later authorization decision is made with the bot
  // token against live guild membership, so there is nothing to keep.
  const token = randomBytes(32).toString('hex');
  db.createWebSession(token, user, Date.now() + config.web.sessionTtlMs);
  setCookie(res, COOKIE, token, config.web.sessionTtlMs);

  return user;
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.deleteWebSession(token);
  clearCookie(res, COOKIE);
}

/** Populates req.user, or 401s. */
export function requireUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const session = token && db.getWebSession(token);
  if (!session) return res.status(401).json({ error: 'Not signed in' });

  req.user = { id: session.user_id, username: session.username, avatar: session.avatar };
  next();
}

/**
 * A user may view and manage a guild if the bot is in it and they either hold Manage Server or
 * the guild's configured manager role — the same rule the slash commands apply. Membership is
 * read live from Discord, so losing the role revokes dashboard access immediately.
 */
export async function getAccess(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    return null; // Not in the server.
  }

  const isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);
  const guildConfig = db.getGuildConfig(guildId);
  const hasRole = Boolean(guildConfig && member.roles.cache.has(guildConfig.manager_role_id));

  if (!isAdmin && !hasRole) return null;
  return { guild, guildConfig, isAdmin };
}
