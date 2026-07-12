import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import RadarIcon from '@mui/icons-material/Radar';

export default function Login({ error }) {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh', p: 2 }}>
      <Paper sx={{ p: 5, maxWidth: 420, width: '100%', textAlign: 'center' }} elevation={0}>
        <Stack spacing={3} alignItems="center">
          <RadarIcon color="primary" sx={{ fontSize: 48 }} />

          <Box>
            <Typography variant="h5" gutterBottom>
              RC Notify
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Monitor VATSIM CIDs and position prefixes, and get a Discord embed the moment they
              connect.
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ width: '100%' }}>
              {error}
            </Alert>
          )}

          <Button variant="contained" size="large" fullWidth href="/auth/login">
            Sign in with Discord
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
