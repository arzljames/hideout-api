import { describe, expect, it } from 'vitest';
import { clientEvents, serverEvents } from '../src/contracts/events.js';

describe('realtime event contract', () => {
  it('defines every server event listed in CLAUDE.md', () => {
    const names = (kind: keyof typeof serverEvents) => Object.keys(serverEvents[kind]).sort();
    expect(names('channel')).toEqual(['message:created', 'message:deleted', 'message:updated']);
    expect(names('room')).toEqual([
      'channel:created',
      'channel:deleted',
      'channel:updated',
      'member:joined',
      'member:left',
      'member:role_changed',
      'room:deleted',
      'room:updated',
      'voice:participants',
    ]);
    expect(names('user')).toEqual(['invite:received', 'member:removed', 'session:expired']);
  });

  it('only lets browsers send typing on channel topics', () => {
    expect(Object.keys(clientEvents)).toEqual(['channel']);
    expect(Object.keys(clientEvents.channel)).toEqual(['typing']);
  });

  it('rejects non-https avatar URLs (e.g. javascript:)', () => {
    const author = { id: '11111111-1111-4111-8111-111111111111', displayName: 'x' };
    const schema = serverEvents.room['voice:participants'];
    const withAvatar = (avatarUrl: string | null) =>
      schema.safeParse({ channelId: author.id, participants: [{ ...author, avatarUrl }] }).success;
    expect(withAvatar('https://avatars.steamstatic.com/a.jpg')).toBe(true);
    expect(withAvatar(null)).toBe(true);
    expect(withAvatar('javascript:alert(1)')).toBe(false);
    expect(withAvatar('http://example.com/a.jpg')).toBe(false);
  });

  it('accepts any 8-4-4-4-12 hex id, including hand-written seed ids', () => {
    const ok = serverEvents.room['room:deleted'].safeParse({ id: '00000000-0000-0000-0000-000000000001' });
    expect(ok.success).toBe(true);
  });
});
