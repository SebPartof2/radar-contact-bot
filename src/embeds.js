import { EmbedBuilder } from 'discord.js';
import { showsPositionName } from './vnas.js';
import { MEDALS, getStanding } from './ironmic.js';

const hours = (value) => `${value.toFixed(1)}h`;

/** "#2 TWR · 84.4h" plus the gap to whoever is directly above and below them. */
function ironMicValue({ rank, category, hours: total, above, below }) {
  const gaps = [
    above && `${hours(above.gapHours)} behind \`${above.callsign}\``,
    below && `${hours(below.gapHours)} ahead of \`${below.callsign}\``,
  ].filter(Boolean);

  return `${MEDALS[rank]} **#${rank} ${category}** · ${hours(total)}\n${gaps.join('\n')}`;
}

const COLORS = {
  DEL: 0x9b59b6,
  GND: 0x2ecc71,
  TWR: 0xe74c3c,
  APP: 0x3498db,
  CTR: 0xf1c40f,
  FSS: 0x95a5a6,
  pilot: 0x1abc9c,
};

const FIELD_LIMIT = 1024;

function block(text, language = '') {
  const fence = '```';
  const room = FIELD_LIMIT - fence.length * 2 - language.length - 3; // fences + newlines
  const body = text.length > room ? `${text.slice(0, room - 1)}…` : text;
  return `${fence}${language}\n${body}\n${fence}`;
}

function watchNote(watch, label) {
  // Position and facility watches carry a human label (the position or facility name), because
  // the stored value is a ULID or a bare facility id that means nothing on its own.
  const targets = {
    cid: `CID ${watch.value}`,
    prefix: `${watch.value}_* positions`,
    position: label ?? `position ${watch.value}`,
    facility: label ?? watch.value,
  };
  const target = targets[watch.kind] ?? watch.value;

  const suffix = watch.kind === 'cid' || watch.kind === 'prefix' ? (label ? ` · ${label}` : '') : '';
  return `Watching ${target}${suffix}`;
}

export function buildEmbed(connection, watch, label) {
  if (connection.type !== 'controller') return pilotEmbed(connection, watch, label);
  // vNAS knows what the controller is actually working, so it wins when it has them.
  return connection.vnas
    ? vnasControllerEmbed(connection, watch, label)
    : controllerEmbed(connection, watch, label);
}

function vnasControllerEmbed(c, watch, label) {
  const v = c.vnas;
  const logon = Math.floor(new Date(v.loginTime ?? c.logonTime).getTime() / 1000);

  // The radio name alone is ambiguous for the positions that split into sectors, so those
  // get the sector name too: "Miami Center (KEY WEST 06) is online".
  const title = showsPositionName(c.callsign)
    ? `${v.primary.radioName} (${v.primary.positionName}) is online`
    : `${v.primary.radioName} is online`;

  // realName comes back as the CID when the controller hides it; the VATSIM feed still has it.
  const name = !v.realName || v.realName === v.cid ? c.name : v.realName;

  const embed = new EmbedBuilder()
    .setColor(COLORS[c.facility] ?? 0x5865f2)
    .setTitle(title)
    .setDescription(`**${name}** · ${v.rating}`)
    .addFields(
      {
        name: 'Facility',
        value: `${v.primary.facilityName} (${v.primary.facilityId})`,
        inline: true,
      },
      { name: 'Frequency', value: `\`${v.primary.frequency}\``, inline: true },
      { name: 'Logged on', value: `<t:${logon}:R>`, inline: true },
      { name: 'Callsign', value: `\`${c.callsign}\``, inline: true },
    );

  // Only shown when this callsign is on the iron mic podium for its category.
  const standing = getStanding(c.callsign);
  if (standing) {
    embed.addFields({
      name: 'Iron Mic',
      value: ironMicValue(standing),
      inline: true,
    });
  }

  // Only controllers actually covering other positions get this field.
  if (v.topDown.length > 0) {
    embed.addFields({
      name: 'Secondary Displays',
      value: v.topDown.map((position) => position.radioName).join('\n'),
      inline: true,
    });
  }

  embed
    .addFields({
      name: 'Controller Info',
      value: v.controllerInfo ? block(v.controllerInfo) : '*None set*',
    })
    .setFooter({ text: `vNAS · ${watchNote(watch, label)}` })
    .setTimestamp();

  return embed;
}

function controllerEmbed(c, watch, label) {
  const logon = Math.floor(new Date(c.logonTime).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(COLORS[c.facility] ?? 0x5865f2)
    .setTitle(`${c.callsign} is online`)
    .setDescription(`**${c.name}** (${c.cid}) · ${c.rating}`)
    .addFields(
      { name: 'Frequency', value: `\`${c.frequency}\``, inline: true },
      { name: 'Facility', value: c.facility, inline: true },
      { name: 'Logged on', value: `<t:${logon}:R>`, inline: true },
      { name: 'Controller Info', value: c.atis ? block(c.atis) : '*None set*' },
    )
    .setFooter({ text: watchNote(watch, label) })
    .setTimestamp();

  return embed;
}

function pilotEmbed(p, watch, label) {
  const logon = Math.floor(new Date(p.logonTime).getTime() / 1000);
  const plan = p.flightPlan;

  const embed = new EmbedBuilder()
    .setColor(COLORS.pilot)
    .setTitle(`${p.callsign} is online`)
    .setDescription(`**${p.name}** (${p.cid})`)
    .setFooter({ text: watchNote(watch, label) })
    .setTimestamp();

  if (!plan) {
    embed.addFields(
      { name: 'Flight plan', value: '*None filed yet*' },
      { name: 'Logged on', value: `<t:${logon}:R>`, inline: true },
    );
    return embed;
  }

  embed.addFields(
    { name: 'Route', value: `**${plan.departure} → ${plan.arrival}**`, inline: true },
    { name: 'Aircraft', value: plan.aircraft || '—', inline: true },
    {
      name: 'Cruise',
      value: [plan.cruise, plan.rules && `(${plan.rules})`].filter(Boolean).join(' ') || '—',
      inline: true,
    },
    { name: 'Filed route', value: plan.route ? block(plan.route) : '*No route filed*' },
  );

  if (plan.alternate) {
    embed.addFields({ name: 'Alternate', value: plan.alternate, inline: true });
  }
  embed.addFields({ name: 'Logged on', value: `<t:${logon}:R>`, inline: true });

  return embed;
}
