const SNOWFLAKE = /^\d{17,20}$/;
const EMBED_COLOR = 0xe5333f;
const TITLE = 'Contact Dealers';
const FOOTER = 'ROYAL CARS · LIVE LEDENLIJST';
const DESCRIPTION_LIMIT = 4096;
const MESSAGE_EMBED_LIMIT = 6000;
const MAX_EMBEDS = 2;

function safeLabel(value, fallback) {
  const raw = String(value || fallback).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() || fallback;
  let label = '';
  for (const char of raw) {
    // Keep names as text, even if a Discord nickname contains Markdown or a mention.
    const token = char === '@' ? '@\u200b' : /[\\`*_~|<>()[\]]/.test(char) ? '\\' + char : char;
    if (label.length + token.length > 95) return label + '…';
    label += token;
  }
  return label;
}

const labelOf = member => String(member.displayName || member.username || member.id || 'Onbekende medewerker');
const plural = (count, singular, pluralForm) => count === 1 ? singular : pluralForm;
const textLength = embed => (embed.title?.length || 0) + embed.description.length + (embed.footer?.text.length || 0);

/** Render the website's rank groups as a single editable Discord message. */
export function renderRosterMessage({ members = [], ranks = [] } = {}) {
  const orderedRanks = [...ranks].sort((a, b) => a.order - b.order);
  const grouped = new Map(orderedRanks.map(rank => [rank.id, []]));
  for (const member of members) grouped.get(member.rank?.id)?.push(member);
  for (const group of grouped.values()) group.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));

  const totalMembers = [...grouped.values()].reduce((sum, group) => sum + group.length, 0);
  const rankCount = orderedRanks.length;
  const description = rankCount
    ? `**${totalMembers}** ${plural(totalMembers, 'medewerker', 'medewerkers')}`
    : 'Er zijn nog geen personeelsrangen gekoppeld.';
  const embeds = [{ description, color: EMBED_COLOR, footer: { text: FOOTER } }];
  const overflow = shown => `\n\n**Ingekort:** ${shown} van ${totalMembers} medewerkers zichtbaar.`;
  const reserve = overflow(totalMembers).length;
  let displayed = 0;
  let completeRanks = 0;
  let chars = textLength(embeds[0]);
  let current = embeds[0];

  function append(text) {
    if (current.description.length + text.length + reserve > DESCRIPTION_LIMIT ||
        chars + text.length + reserve > MESSAGE_EMBED_LIMIT) return false;
    current.description += text;
    chars += text.length;
    return true;
  }

  function startSection(text) {
    if (append(current.description ? '\n\n\n' + text : text)) return true;
    const title = TITLE + ' (vervolg)';
    if (embeds.length >= MAX_EMBEDS || chars + title.length + text.length + reserve > MESSAGE_EMBED_LIMIT) return false;
    current = { title, description: '', color: EMBED_COLOR };
    embeds.push(current);
    chars += title.length;
    return append(text);
  }

  outer: for (const rank of orderedRanks) {
    const group = grouped.get(rank.id);
    const rankName = SNOWFLAKE.test(rank.roleId || '') ? `<@&${rank.roleId}>` : safeLabel(rank.name, 'Onbekende rang');
    const number = String(rank.order + 1).padStart(2, '0');
    const heading = (continuation = false) => `**${number} · ${rankName}** · ${group.length} ${plural(group.length, 'lid', 'leden')}${continuation ? ' (vervolg)' : ''}`;
    if (!group.length) {
      if (!startSection(heading() + '\n\n_Nog geen medewerkers aan deze rang gekoppeld._')) break;
      completeRanks++;
      continue;
    }
    for (const [index, member] of group.entries()) {
      const memberName = SNOWFLAKE.test(member.id || '') ? `<@${member.id}>` : safeLabel(labelOf(member), 'Onbekende medewerker');
      const line = '• ' + memberName;
      if (index === 0) {
        if (!startSection(heading() + '\n\n' + line)) break outer;
      } else if (!append('\n\n' + line) && !startSection(heading(true) + '\n\n' + line)) break outer;
      displayed++;
    }
    completeRanks++;
  }
  if (completeRanks < rankCount) current.description += overflow(displayed);

  return { content: `# ${TITLE}`, embeds, allowedMentions: { parse: [], repliedUser: false } };
}
