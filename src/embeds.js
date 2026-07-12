import { EmbedBuilder } from 'discord.js';

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
  const target = watch.kind === 'cid' ? `CID ${watch.value}` : `${watch.value}_* positions`;
  return label ? `Watching ${target} · ${label}` : `Watching ${target}`;
}

export function buildEmbed(connection, watch, label) {
  return connection.type === 'controller'
    ? controllerEmbed(connection, watch, label)
    : pilotEmbed(connection, watch, label);
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
      { name: 'Controller ATIS', value: c.atis ? block(c.atis) : '*No ATIS set*' },
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
