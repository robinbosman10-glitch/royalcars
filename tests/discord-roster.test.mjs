import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRosterMessage } from '../lib/discord-roster.mjs';

const directie = { id: 'directie', name: 'Directie', order: 0 };
const sales = { id: 'sales', name: 'Verkoop', order: 1 };
const intern = { id: 'intern', name: 'Proeftijd', order: 2 };
const member = (displayName, rank) => ({ displayName, rank });

test('roster follows website rank order and alphabetical names, including empty ranks', () => {
  const result = renderRosterMessage({
    ranks: [sales, intern, directie],
    members: [member('Zara', sales), member('Bram', directie), member('Anna', sales), member('Oud lid', { id: 'deleted' })],
  });
  assert.deepEqual(result.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(result.embeds.length, 1);
  const { description } = result.embeds[0];
  assert.match(description, /\*\*3\*\* medewerkers · \*\*3\*\* rangen/);
  assert.match(description, /01 · Directie\*\* · 1 lid\n• Bram[\s\S]*02 · Verkoop\*\* · 2 leden\n• Anna\n• Zara[\s\S]*03 · Proeftijd/);
  assert.match(description, /Nog geen medewerkers/);
  assert.doesNotMatch(description, /Oud lid/);
  assert.match(description, /https:\/\/royalcarsadmin\.nl\/#members/);
});

test('names cannot create mentions or alter the roster formatting', () => {
  const nickname = '*Eve*\n@everyone <@123456789012345678>';
  const result = renderRosterMessage({ ranks: [sales], members: [member(nickname, sales)] });
  const { description } = result.embeds[0];
  assert.doesNotMatch(description, /@everyone|<@123456789012345678>|\n@/);
  assert.ok(description.includes('\\*Eve\\*'));
  assert.equal((description.match(/^• /gm) || []).length, 1);
  assert.deepEqual(result.allowedMentions.parse, []);
});

test('a full roster fits in one message, reports omitted rows and is deterministic', () => {
  const ranks = [directie, sales, intern];
  const members = Array.from({ length: 500 }, (_, index) => member(`Personeel ${String(index).padStart(3, '0')} ${'🏎️'.repeat(100)}`, sales));
  members.push(member('Robin', directie));
  const first = renderRosterMessage({ ranks, members });
  const second = renderRosterMessage({ ranks, members });
  assert.deepEqual(first, second);
  assert.equal(first.embeds.length, 2);
  assert.ok(first.embeds.every(embed => embed.description.length <= 4096 && embed.title.length <= 256));
  const totalLength = first.embeds.reduce((count, embed) => count + embed.title.length + embed.description.length + (embed.footer?.text.length || 0), 0);
  assert.ok(totalLength <= 6000);
  const all = first.embeds.map(embed => embed.description).join('\n');
  const displayed = (all.match(/^• /gm) || []).length;
  assert.ok(displayed > 50);
  assert.match(all, new RegExp(`Ingekort:\\*\\* ${displayed} van 501 medewerkers · 1 van 3 rangen volledig`));
  assert.match(all, /Verkoop\*\* · 500 leden \(vervolg\)/);
  assert.doesNotMatch(all, /\p{Surrogate}/u);
});

test('the unconfigured roster links to the portal without listing unrelated users', () => {
  const { embeds } = renderRosterMessage();
  assert.match(embeds[0].description, /nog geen personeelsrangen gekoppeld/);
  assert.match(embeds[0].description, /royalcarsadmin\.nl\/#members/);
});
