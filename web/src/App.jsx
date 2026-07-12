import { useCallback, useEffect, useState } from 'react';
import {
  AppBar,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Container,
  MenuItem,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import RadarIcon from '@mui/icons-material/Radar';
import { api } from './api.js';
import Login from './Login.jsx';
import GuildDashboard from './GuildDashboard.jsx';

const guildIcon = (guild) =>
  guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : undefined;

export default function App() {
  const [state, setState] = useState({ status: 'loading' });
  const [guildId, setGuildId] = useState('');

  const load = useCallback(async () => {
    try {
      const { user, guilds } = await api.me();
      setState({ status: 'ready', user, guilds });
      setGuildId((current) => current || guilds[0]?.id || '');
    } catch (error) {
      setState(error.code === 401 ? { status: 'anonymous' } : { status: 'error', error });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (state.status === 'anonymous') return <Login />;
  if (state.status === 'error') return <Login error={state.error.message} />;

  const { user, guilds } = state;

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <AppBar position="sticky" color="transparent" elevation={0} sx={{ backdropFilter: 'blur(8px)', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 2 }}>
          <RadarIcon color="primary" />
          <Typography variant="h6" sx={{ mr: 2 }}>
            RC Notify
          </Typography>

          {guilds.length > 0 && (
            <TextField
              select
              size="small"
              value={guildId}
              onChange={(event) => setGuildId(event.target.value)}
              sx={{ minWidth: 220 }}
            >
              {guilds.map((guild) => (
                <MenuItem key={guild.id} value={guild.id}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Avatar src={guildIcon(guild)} sx={{ width: 22, height: 22, fontSize: 12 }}>
                      {guild.name[0]}
                    </Avatar>
                    <span>{guild.name}</span>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
          )}

          <Box sx={{ flexGrow: 1 }} />

          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar
              src={
                user.avatar
                  ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
                  : undefined
              }
              sx={{ width: 30, height: 30 }}
            >
              {user.username[0]}
            </Avatar>
            <Typography variant="body2" color="text.secondary">
              {user.username}
            </Typography>
            <Button
              size="small"
              color="inherit"
              onClick={async () => {
                await api.logout();
                setState({ status: 'anonymous' });
              }}
            >
              Sign out
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: 4 }}>
        {guilds.length === 0 ? (
          <Typography color="text.secondary">
            You do not have access to any server running RC Notify. You need <b>Manage Server</b>,
            or the manager role that server has configured.
          </Typography>
        ) : (
          <GuildDashboard
            key={guildId}
            guildId={guildId}
            isAdmin={guilds.find((g) => g.id === guildId)?.isAdmin}
            onConfigured={load}
          />
        )}
      </Container>
    </Box>
  );
}
