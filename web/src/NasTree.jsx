import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import PublicIcon from '@mui/icons-material/Public';
import { api } from './api.js';

const FACILITY_TYPES = {
  Artcc: { label: 'ARTCC', color: '#f1c40f' },
  Tracon: { label: 'TRACON', color: '#3498db' },
  Atct: { label: 'ATCT', color: '#e74c3c' },
  Nas: { label: 'NAS', color: '#5865f2' },
};

/** Colour positions the way controllers already read callsigns: by the suffix. */
const POSITION_COLORS = {
  CTR: '#f1c40f',
  APP: '#3498db',
  DEP: '#3498db',
  TWR: '#e74c3c',
  GND: '#2ecc71',
  DEL: '#9b59b6',
  TMU: '#e67e22',
  FSS: '#95a5a6',
};

const positionColor = (callsign) =>
  POSITION_COLORS[String(callsign ?? '').toUpperCase().split('_').pop()] ?? '#8b949e';

const matches = (text, query) => String(text ?? '').toLowerCase().includes(query);

/**
 * Keeps a facility only if it, one of its positions, or one of its descendants matches. The
 * tree is 4,000 positions deep in places, so searching is the only sane way in.
 */
function filterFacility(facility, query) {
  const selfMatches = matches(facility.name, query) || matches(facility.id, query);

  const positions = selfMatches
    ? facility.positions
    : facility.positions.filter(
        (position) =>
          matches(position.callsign, query) ||
          matches(position.radioName, query) ||
          matches(position.name, query),
      );

  const children = facility.children
    .map((child) => filterFacility(child, query))
    .filter(Boolean);

  if (!selfMatches && positions.length === 0 && children.length === 0) return null;
  return { ...facility, positions, children };
}

export default function NasTree({ guildId, isManager }) {
  const [tree, setTree] = useState(null);
  const [watches, setWatches] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const loadWatches = useCallback(async () => {
    const guild = await api.guild(guildId);
    setWatches(guild.watches);
  }, [guildId]);

  useEffect(() => {
    Promise.all([api.nas(), loadWatches()])
      .then(([nas]) => setTree(nas.tree))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [loadWatches]);

  const watchedFacilities = useMemo(
    () => new Set(watches.filter((w) => w.kind === 'facility').map((w) => w.value)),
    [watches],
  );
  const watchedPositions = useMemo(
    () => new Set(watches.filter((w) => w.kind === 'position').map((w) => w.value)),
    [watches],
  );

  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!tree) return null;
    if (!trimmed) return tree;
    return {
      ...tree,
      children: tree.children.map((artcc) => filterFacility(artcc, trimmed)).filter(Boolean),
    };
  }, [tree, trimmed]);

  const toggleExpanded = (id) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleWatch = async (kind, value, watched) => {
    setBusy(value);
    try {
      if (watched) await api.removeWatch(guildId, kind, value);
      else await api.addWatch(guildId, { kind, value });
      await loadWatches();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!tree) {
    return (
      <Alert severity="warning">
        The vNAS airspace tree has not loaded yet. It is fetched once a day on startup — check
        back in a moment.
      </Alert>
    );
  }

  const watchedCount = watchedFacilities.size + watchedPositions.size;

  return (
    <Card elevation={0} variant="outlined">
      <CardHeader
        avatar={<PublicIcon color="primary" />}
        title="National Airspace System"
        subheader={
          watchedCount === 0
            ? 'Tick a facility to watch everything under it, or a single position'
            : `${watchedFacilities.size} facilit${watchedFacilities.size === 1 ? 'y' : 'ies'} and ${watchedPositions.size} position${watchedPositions.size === 1 ? '' : 's'} watched`
        }
        titleTypographyProps={{ variant: 'h6' }}
        action={
          <TextField
            size="small"
            placeholder="Search PHX, Boston Center, ZAB…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            sx={{ minWidth: 280 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        }
      />
      <Divider />
      <CardContent sx={{ p: 0, maxHeight: '65vh', overflow: 'auto' }}>
        {visible.children.length === 0 ? (
          <Typography color="text.secondary" align="center" sx={{ py: 6 }}>
            Nothing matches “{query}”.
          </Typography>
        ) : (
          visible.children.map((artcc) => (
            <FacilityRow
              key={artcc.id}
              facility={artcc}
              depth={0}
              expanded={expanded}
              onToggleExpanded={toggleExpanded}
              watchedFacilities={watchedFacilities}
              watchedPositions={watchedPositions}
              onToggleWatch={toggleWatch}
              isManager={isManager}
              busy={busy}
              // A search auto-opens what it found; otherwise the tree starts collapsed.
              forceOpen={Boolean(trimmed)}
              coveredBy={null}
            />
          ))
        )}
      </CardContent>

      <Snackbar open={Boolean(error)} autoHideDuration={6000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Card>
  );
}

function FacilityRow({
  facility,
  depth,
  expanded,
  onToggleExpanded,
  watchedFacilities,
  watchedPositions,
  onToggleWatch,
  isManager,
  busy,
  forceOpen,
  coveredBy,
}) {
  const open = forceOpen || expanded.has(facility.id);
  const watched = watchedFacilities.has(facility.id);
  // An ancestor already covers everything below it, so nested boxes are checked and locked.
  const covered = coveredBy ?? (watched ? facility.id : null);
  const inherited = Boolean(coveredBy);

  const hasChildren = facility.children.length > 0 || facility.positions.length > 0;
  const type = FACILITY_TYPES[facility.type] ?? { label: facility.type, color: '#8b949e' };

  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        sx={{
          pl: depth * 3,
          pr: 2,
          py: 0.35,
          // A coloured rail on the left makes the depth obvious without counting indents.
          borderLeft: 3,
          borderColor: watched || inherited ? type.color : 'transparent',
          bgcolor: watched ? `${type.color}14` : 'transparent',
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        <IconButton
          size="small"
          onClick={() => onToggleExpanded(facility.id)}
          disabled={!hasChildren || forceOpen}
          sx={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>

        <Tooltip
          title={
            inherited
              ? `Already covered by ${coveredBy}`
              : `Watch every position under ${facility.id}`
          }
        >
          <span>
            <Checkbox
              size="small"
              checked={watched || inherited}
              disabled={!isManager || inherited || busy === facility.id}
              onChange={() => onToggleWatch('facility', facility.id, watched)}
              sx={{ color: type.color, '&.Mui-checked': { color: type.color } }}
            />
          </span>
        </Tooltip>

        <Chip
          label={type.label}
          size="small"
          sx={{
            height: 18,
            fontSize: 10,
            fontWeight: 700,
            minWidth: 58,
            color: type.color,
            bgcolor: `${type.color}22`,
            border: 'none',
          }}
        />

        <Typography
          variant="body2"
          sx={{ fontWeight: depth === 0 ? 700 : 500, fontFamily: 'monospace', color: type.color }}
        >
          {facility.id}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: depth === 0 ? 600 : 400 }}>
          {facility.name}
        </Typography>

        <Box sx={{ flexGrow: 1 }} />
        {facility.positions.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {facility.positions.length} pos
          </Typography>
        )}
      </Stack>

      <Collapse in={open} unmountOnExit>
        {/* Child facilities first: the airspace hierarchy matters more than one facility's
            own positions, and burying a TRACON under 40 Center sectors hides it. */}
        {facility.children.map((child) => (
          <FacilityRow
            key={child.id}
            facility={child}
            depth={depth + 1}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            watchedFacilities={watchedFacilities}
            watchedPositions={watchedPositions}
            onToggleWatch={onToggleWatch}
            isManager={isManager}
            busy={busy}
            forceOpen={forceOpen}
            coveredBy={covered}
          />
        ))}

        {facility.positions.map((position) => {
          const positionWatched = watchedPositions.has(position.id);
          const color = positionColor(position.callsign);
          const on = positionWatched || Boolean(covered);

          return (
            <Stack
              key={position.id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                pl: (depth + 1) * 3 + 4.5,
                pr: 2,
                py: 0.1,
                borderLeft: 3,
                borderColor: on ? color : 'transparent',
                bgcolor: positionWatched ? `${color}14` : 'transparent',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Tooltip title={covered ? `Already covered by ${covered}` : 'Watch this position'}>
                <span>
                  <Checkbox
                    size="small"
                    checked={on}
                    disabled={!isManager || Boolean(covered) || busy === position.id}
                    onChange={() => onToggleWatch('position', position.id, positionWatched)}
                    sx={{ color, '&.Mui-checked': { color } }}
                  />
                </span>
              </Tooltip>

              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace', fontWeight: 600, color, minWidth: 120 }}
              >
                {position.callsign}
              </Typography>
              <Typography variant="body2" sx={{ minWidth: 170 }}>
                {position.radioName}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
                {position.name}
              </Typography>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', color }}>
                {position.frequency}
              </Typography>
            </Stack>
          );
        })}
      </Collapse>
    </>
  );
}
