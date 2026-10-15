import { describe, expect, it } from 'vitest';
import {
  activeMention,
  insertMention,
  matchMembers,
  mentionedUsernames,
  mentionParts,
} from './mentions.js';

describe('mentions (CHAT-073)', () => {
  it('finds @usernames, once each, but not inside words or email addresses', () => {
    expect(mentionedUsernames('Hey @Ben and @clara_n, ping @ben again')).toEqual([
      'ben',
      'clara_n',
    ]);
    expect(mentionedUsernames('mail me@example.com or x@ben')).toEqual([]);
    expect(mentionedUsernames('(@ben) @ab @@ben')).toEqual(['ben']);
    expect(mentionedUsernames(null)).toEqual([]);
  });

  it('splits text into plain parts and accepted mentions', () => {
    expect(mentionParts('hi @ben and @nobody!', (u) => u === 'ben')).toEqual([
      { text: 'hi ' },
      { text: '@ben', mention: 'ben' },
      { text: ' and @nobody!' },
    ]);
    expect(mentionParts('@ben', () => true)).toEqual([{ text: '@ben', mention: 'ben' }]);
  });

  it('knows the @name being typed and replaces it with the chosen username', () => {
    expect(activeMention('hello @be', 9)).toEqual({ start: 6, query: 'be' });
    expect(activeMention('hello @', 7)).toEqual({ start: 6, query: '' });
    expect(activeMention('me@ex', 5)).toBeNull();
    expect(activeMention('@ben done', 9)).toBeNull();
    expect(insertMention('hello @be!', 6, 9, 'ben')).toEqual({ text: 'hello @ben !', caret: 11 });
    expect(insertMention('@cl world', 0, 3, 'clara')).toEqual({ text: '@clara world', caret: 7 });
  });

  it('ranks members by username, then display name, skipping yourself', () => {
    const members = [
      { userId: '1', username: 'anna', displayName: 'Anna Schmidt' },
      { userId: '2', username: 'ben', displayName: 'Ben Okafor' },
      { userId: '3', username: 'zed', displayName: 'Bea Novak' },
      { userId: '4', username: 'carl', displayName: 'Carl Benson' },
    ];
    expect(matchMembers(members, 'be', '1').map((m) => m.userId)).toEqual(['2', '3', '4']);
    expect(matchMembers(members, '', '1').map((m) => m.userId)).toEqual(['3', '2', '4']);
  });
});
