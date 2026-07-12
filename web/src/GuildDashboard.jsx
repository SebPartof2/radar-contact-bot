import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import FlightIcon from '@mui/icons-material/Flight';
import { api } from './api.js';

const LIVE_REFRESH_MS = 15_000;

export default function GuildDashboard({ guildId, isAdmin, onConfigured }) {
  const [guild, setGuild] = useState(null);
  const [live, setLive] = useState([]);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const [channelId, setChannelId] = useState('');
  const [roleId, setRoleId] = useState('');

  const loadGuild = useCallback(async () => {
    const data = await api.guild(guildId);
    setGuild(data);
    setChannelId(data.config?.channelId ?? '');
    setRoleId(data.config?.managerRoleId ?? '');
  }, [guildId]);

  const loadLive = useCallback(async () => {
    const { live } = await api.live(guildId);
    setLive(live);
  }, [guildId]);

  useEffect(() => {
    loadGuild().catch((e) => setError(e.message));
  }, [loadGuild]);

  // The bot polls VATSIM every 15s, so matching that keeps the panel a poll behind at worst.
  useEffect(() => {
    loadLive().catch(() => {});
    const id = setInterval(() => loadLive().catch(() => {}), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadLive]);

  const run = async (action, message) => {
    try {
      await action();
      await loadGuild();
      setToast(message);
    } catch (e) {
      setError(e.message);
    }
  };

  if (!guild) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const dirty = channelId !== (guild.config?.channelId ?? '') || roleId !== (guild.config?.managerRoleId ?? '');

  return (
    <Stack spacing={3}>
      {!guild.config && (
        <Alert severity="info">
          RC Notify is not set up in <b>{guild.name}</b> yet. Choose a notification channel and a
          manager role below to start monitoring.
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={5}>
          <Card elevation={0} variant="outlined" sx={{ height: '100%' }}>
            <CardHeader
              title="Configuration"
              subheader={isAdmin ? 'Where notifications go, and who may edit monitors' : 'Manage Server is required to change this'}
              titleTypographyProps={{ variant: 'h6' }}
            />
            <CardContent>
              <Stack spacing={2.5}>
                <TextField
                  select
                  fullWidth
                  label="Notification channel"
                  value={channelId}
                  disabled={!isAdmin}
                  onChange={(e) => setChannelId(e.target.value)}
                  helperText={
                    guild.channels.length === 0
                      ? 'No channel gives the bot View, Send, Embed Links, and Manage Messages'
                      : 'Only channels the bot can post and delete in are listed'
                  }
                >
                  {guild.channels.map((channel) => (
                    <MenuItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </MenuItem>
                  ))}
                </TextField>

                <TextField
                  select
                  fullWidth
                  label="Manager role"
                  value={roleId}
                  disabled={!isAdmin}
                  onChange={(e) => setRoleId(e.target.value)}
                  helperText="Members with this role may add and remove monitors"
                >
                  {guild.roles.map((role) => (
                    <MenuItem key={role.id} value={role.id}>
                      <Box component="span" sx={{ color: role.color === '#000000' ? 'inherit' : role.color }}>
                        @{role.name}
                      </Box>
                    </MenuItem>
                  ))}
                </TextField>

                <Button
                  variant="contained"
                  disabled={!isAdmin || !dirty || !channelId || !roleId}
                  onClick={() =>
                    run(async () => {
                      await api.saveConfig(guildId, { channelId, managerRoleId: roleId });
                      onConfigured?.();
                    }, 'Configuration saved')
                  }
                >
                  Save
                </Button>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={7}>
          <Card elevation={0} variant="outlined" sx={{ height: '100%' }}>
            <CardHeader
              title="Monitors"
              subheader={`${guild.watches.length} watched`}
              titleTypographyProps={{ variant: 'h6' }}
              action={
                <Button
                  startIcon={<AddIcon />}
                  onClick={() => setAdding(true)}
                  disabled={!guild.config}
                >
                  Add
                </Button>
              }
            />
            <Divider />
            <CardContent sx={{ p: 0 }}>
              {guild.watches.length === 0 ? (
                <Typography color="text.secondary" sx={{ p: 3 }}>
                  Nothing is being monitored yet.
                </Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Type</TableCell>
                      <TableCell>Target</TableCell>
                      <TableCell>Label</TableCell>
                      <TableCell align="right" />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {guild.watches.map((watch) => (
                      <TableRow key={`${watch.kind}:${watch.value}`} hover>
                        <TableCell>
                          <Chip
                            size="small"
                            label={watch.kind === 'cid' ? 'CID' : 'Prefix'}
                            color={watch.kind === 'cid' ? 'secondary' : 'primary'}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>
                          {watch.kind === 'cid' ? watch.value : `${watch.value}_*`}
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{watch.label || '—'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Remove">
                            <IconButton
                              size="small"
                              onClick={() =>
                                run(
                                  () => api.removeWatch(guildId, watch.kind, watch.value),
                                  'Monitor removed',
                                )
                              }
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card elevation={0} variant="outlined">
        <CardHeader
          title="Online now"
          subheader={`${live.length} monitored connection${live.length === 1 ? '' : 's'} on the network`}
          titleTypographyProps={{ variant: 'h6' }}
        />
        <Divider />
        <CardContent>
          {live.length === 0 ? (
            <Typography color="text.secondary">
              None of the monitored people or positions are online right now.
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {live.map((entry) => (
                <Grid item xs={12} md={6} key={`${entry.cid}:${entry.callsign}`}>
                  <LiveCard entry={entry} />
                </Grid>
              ))}
            </Grid>
          )}
        </CardContent>
      </Card>

      <AddWatchDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSubmit={(body) => run(() => api.addWatch(guildId, body), 'Monitor added')}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      <Snackbar open={Boolean(error)} autoHideDuration={6000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Stack>
  );
}

function LiveCard({ entry }) {
  const controller = entry.type === 'controller';
  const plan = entry.flightPlan;

  return (
    <Card variant="outlined" elevation={0} sx={{ height: '100%', bgcolor: 'background.default' }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
          {controller ? <HeadsetMicIcon color="error" /> : <FlightIcon color="secondary" />}
          <Typography variant="subtitle1" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
            {entry.callsign}
          </Typography>
          {controller && <Chip size="small" label={entry.frequency} variant="outlined" />}
          <Box sx={{ flexGrow: 1 }} />
          <Chip
            size="small"
            variant="outlined"
            label={entry.watch.kind === 'cid' ? `CID ${entry.watch.value}` : `${entry.watch.value}_*`}
          />
        </Stack>

        <Typography variant="body2" color="text.secondary" gutterBottom>
          {entry.name} ({entry.cid}) {entry.rating ? `· ${entry.rating}` : ''}
        </Typography>

        {controller ? (
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 1,
              p: 1.5,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              maxHeight: 140,
              overflow: 'auto',
            }}
          >
            {entry.atis || 'No ATIS set'}
          </Box>
        ) : plan ? (
          <Stack spacing={1} sx={{ mt: 1 }}>
            <Typography variant="body2">
              <b>
                {plan.departure} → {plan.arrival}
              </b>{' '}
              <Box component="span" sx={{ color: 'text.secondary' }}>
                {plan.aircraft} {plan.cruise && `· ${plan.cruise}`}
              </Box>
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                borderRadius: 1,
                bgcolor: 'action.hover',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                maxHeight: 120,
                overflow: 'auto',
              }}
            >
              {plan.route || 'No route filed'}
            </Box>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No flight plan filed
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function AddWatchDialog({ open, onClose, onSubmit }) {
  const [kind, setKind] = useState('cid');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');

  const close = () => {
    setValue('');
    setLabel('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Add a monitor</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField select label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
            <MenuItem value="cid">CID — a specific person, flying or controlling</MenuItem>
            <MenuItem value="prefix">Position prefix — any controller at a facility</MenuItem>
          </TextField>

          <TextField
            autoFocus
            label={kind === 'cid' ? 'VATSIM CID' : 'Position prefix'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kind === 'cid' ? '1234567' : 'SFO'}
            helperText={
              kind === 'cid'
                ? 'Matches this person as a pilot or a controller'
                : 'Everything before the underscore — SFO matches SFO_TWR, SFO_GND, …'
            }
          />

          <TextField
            label="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Who or what this is"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!value.trim()}
          onClick={() => {
            onSubmit({ kind, value: value.trim(), label: label.trim() });
            close();
          }}
        >
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
