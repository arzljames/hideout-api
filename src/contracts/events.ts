import { z } from 'zod';

/*
 * Source of truth for every realtime topic, event, and payload.
 * `npm run contracts` turns this into contract/events.schema.json for hideout-web.
 * Changes must be additive: add fields/events, deprecate, remove only after hideout-web ships without them.
 */

export const topics = {
  room: (roomId: string) => `room:${roomId}` as const,
  channel: (channelId: string) => `channel:${channelId}` as const,
  user: (profileId: string) => `user:${profileId}` as const,
};

export type TopicKind = keyof typeof topics;

/**
 * Topics browsers send on. Kept apart from `topics` because Realtime checks send rights
 * once per join, not per event: browsers may send anything on these, so Node's topics
 * (`room:` broadcasts, `channel:`, `user:`) stay receive-only for them.
 */
export const clientTopics = {
  typing: (channelId: string) => `typing:${channelId}` as const,
};

// z.guid(): any 8-4-4-4-12 hex id (seed data needn't carry RFC 9562 version bits).
const Id = z.guid();
const Timestamp = z.iso.datetime({ offset: true });
// Rendered by every member's browser, so never plain http or other schemes.
const HttpsUrl = z.url({ protocol: /^https$/ });

export const ProfileSummary = z.object({ id: Id, displayName: z.string(), avatarUrl: HttpsUrl.nullable() });

export const Role = z.enum(['owner', 'admin', 'member']);

export const Message = z.object({
  id: Id,
  channelId: Id,
  // Null once the author's profile is deleted (messages.author_id is on delete set null).
  author: ProfileSummary.nullable(),
  body: z.string(),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
});

export const ChannelType = z.enum(['text', 'voice']);

export const Channel = z.object({
  id: Id,
  roomId: Id,
  type: ChannelType,
  name: z.string(),
  position: z.number().int(),
});

/** A room always has exactly one icon: an emoji, or an uploaded image served as a short-lived signed URL. */
export const RoomIcon = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('emoji'), emoji: z.string() }),
  z.object({ kind: z.literal('image'), url: HttpsUrl }),
]);

// No owner field: ownership is the member whose role is 'owner' (see Member).
export const Room = z.object({ id: Id, name: z.string(), icon: RoomIcon, createdAt: Timestamp });

export const Member = z.object({
  roomId: Id,
  user: ProfileSummary,
  role: Role,
  joinedAt: Timestamp,
  // Steam's "currently playing", cached by Node; null when not in a game or unknown.
  currentGame: z.string().nullable(),
});

/** Shared shapes, emitted once under `$defs` so hideout-web generates one named type each. */
export const sharedSchemas = { ProfileSummary, Role, Message, Channel, RoomIcon, Room, Member };

// Events Node broadcasts, grouped by topic kind

export const serverEvents = {
  channel: {
    'message:created': z.object({ message: Message }),
    'message:updated': z.object({ message: Message }),
    'message:deleted': z.object({ id: Id, channelId: Id }),
  },
  room: {
    'channel:created': z.object({ channel: Channel }),
    'channel:updated': z.object({ channel: Channel }),
    'channel:deleted': z.object({ id: Id, roomId: Id }),
    // Every live channel of `type` in the room, in their new order (first = top).
    'channel:reordered': z.object({ roomId: Id, type: ChannelType, channelIds: z.array(Id) }),
    'member:joined': z.object({ member: Member }),
    'member:left': z.object({ roomId: Id, userId: Id }),
    'member:role_changed': z.object({ roomId: Id, userId: Id, role: Role }),
    'voice:participants': z.object({ channelId: Id, participants: z.array(ProfileSummary) }),
    'room:updated': z.object({ room: Room }),
    'room:deleted': z.object({ id: Id }),
  },
  user: {
    'invite:received': z.object({
      inviteId: Id,
      room: Room.pick({ id: true, name: true, icon: true }),
      invitedBy: ProfileSummary,
      expiresAt: Timestamp.nullable(),
    }),
    'member:removed': z.object({ roomId: Id }),
    'session:expired': z.object({}),
  },
} as const satisfies Record<TopicKind, Record<string, z.ZodObject>>;

/*
 * Events browsers may send, keyed by client topic. Other browsers send these, not Node,
 * and RLS can't check their payloads (send rights are checked once per join, without
 * the event), so they are untrusted and carry no display data: receivers resolve names
 * from the member list Node serves and ignore userIds not in it. A member can still
 * spoof another member's typing or Presence; that's accepted for these ephemeral
 * signals, which must never be used for authorization.
 */

export const clientEvents = {
  typing: {
    typing: z.object({ userId: Id }),
  },
} as const satisfies Record<keyof typeof clientTopics, Record<string, z.ZodObject>>;

/** Presence state each browser tracks on `room:<id>`. Untrusted: receivers ignore userIds not in the member list. */
export const RoomPresence = z.object({ userId: Id });

export type ServerEventName<K extends TopicKind> = keyof (typeof serverEvents)[K] & string;
export type ServerEventPayload<K extends TopicKind, E extends ServerEventName<K>> = z.input<
  (typeof serverEvents)[K][E]
>;
