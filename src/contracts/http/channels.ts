import { z } from 'zod';
import { ChannelType as ChannelTypeSchema } from '../events.js';
import { Id, authedErrors, errorResponse } from './common.js';
import { DISPLAY_NAME_RULES, displayName } from './names.js';
import { registry } from './registry.js';
import { Channel, RoomIdParams } from './rooms.js';

/*
 * Channels: create, rename, reorder, delete (owner or admin). Reads come with the room
 * (GET /api/rooms/{roomId} returns every live channel). The Channel shape is the component
 * registered in rooms.ts, shared with the realtime payloads.
 */

/** Rooms can hold at most this many live channels (both types together); enforced by create_channel. */
export const MAX_CHANNELS_PER_ROOM = 50;

// A clone: events.ts may be evaluated before extendZodWithOpenApi runs (see rooms.ts).
export const ChannelType = registry.register('ChannelType', ChannelTypeSchema.clone());
export type ChannelType = z.infer<typeof ChannelType>;

export const ChannelName = registry.register(
  'ChannelName',
  displayName(32).openapi({
    description:
      'Channel name: 1–32 UTF-16 code units after trimming surrounding whitespace. Unique among the room’s live ' +
      `channels of the same type, ignoring case. ${DISPLAY_NAME_RULES}`,
    example: 'general',
  }),
);

export const CreateChannelBody = registry.register(
  'CreateChannelBody',
  z.strictObject({ type: ChannelType, name: ChannelName }),
);
export type CreateChannelBody = z.infer<typeof CreateChannelBody>;

export const RenameChannelBody = registry.register('RenameChannelBody', z.strictObject({ name: ChannelName }));
export type RenameChannelBody = z.infer<typeof RenameChannelBody>;

export const ReorderChannelsBody = registry.register(
  'ReorderChannelsBody',
  z.strictObject({
    type: ChannelType,
    channelIds: z
      .array(Id)
      .min(1, 'List at least one channel.')
      .max(MAX_CHANNELS_PER_ROOM, `List at most ${MAX_CHANNELS_PER_ROOM} channels.`)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
        'Each channel may appear only once.',
      )
      .openapi({
        description: 'Every live channel of `type` in the room, each exactly once, in the new order (first = top).',
        uniqueItems: true,
      }),
  }),
);
export type ReorderChannelsBody = z.infer<typeof ReorderChannelsBody>;

export const ChannelIdParams = z.object({ channelId: Id.openapi({ description: 'Channel id.' }) });

export const ChannelList = registry.register(
  'ChannelList',
  z.object({ data: z.array(Channel).openapi({ description: 'Live channels of one type, by position.' }) }),
);
export type ChannelList = z.infer<typeof ChannelList>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const limitNote = ' Channel writes are rate limited to 60/hour per user.';
const forbidden = errorResponse(
  'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN). ' +
    'Or the caller is a plain member (owner or admin required).',
);
const roomNotFound = errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).');
const channelNotFound = errorResponse(
  'Channel not found or deleted, its room is deleted, or you are not a member of its room (non-members always get 404).',
);
const serverError = errorResponse('Unexpected server error.');

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{roomId}/channels',
  tags: ['channels'],
  summary: 'Create a channel',
  description:
    'Owner or admin only. The new channel is appended to the end of its type. A room holds at most ' +
    `${MAX_CHANNELS_PER_ROOM} live channels. Broadcasts \`channel:created\` on \`room:<roomId>\`. ` +
    'Non-members get 404. Not idempotent: disable the create button while the request is pending.' +
    limitNote +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(CreateChannelBody) } },
  responses: {
    201: { description: 'The new channel.', content: json(Channel) },
    ...authedErrors,
    403: forbidden,
    404: roomNotFound,
    409: errorResponse(
      '`CHANNEL_NAME_TAKEN`: a live channel of this type already has this name (ignoring case). ' +
        '`CHANNEL_LIMIT_REACHED`: the room already has the maximum number of channels.',
    ),
    422: errorResponse('Invalid type or name.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/channels/{channelId}',
  tags: ['channels'],
  summary: 'Rename a channel',
  description:
    'Owner or admin only. Broadcasts `channel:updated` on `room:<roomId>`. Non-members get 404.' +
    limitNote +
    writeNote,
  request: { params: ChannelIdParams, body: { required: true, content: json(RenameChannelBody) } },
  responses: {
    200: { description: 'The renamed channel.', content: json(Channel) },
    ...authedErrors,
    403: forbidden,
    404: channelNotFound,
    409: errorResponse('`CHANNEL_NAME_TAKEN`: another live channel of this type already has this name (ignoring case).'),
    422: errorResponse('Invalid name.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/rooms/{roomId}/channels/order',
  tags: ['channels'],
  summary: 'Reorder a room’s channels of one type',
  description:
    'Owner or admin only. `channelIds` must list every live channel of `type` in the room exactly once; if the ' +
    'list is stale (a channel was created or deleted meanwhile) the response is 409 `CHANNEL_ORDER_STALE`: reload the room ' +
    'and try again. Broadcasts `channel:reordered` on `room:<roomId>`. Non-members get 404.' +
    limitNote +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(ReorderChannelsBody) } },
  responses: {
    200: { description: 'The channels of that type in their new order.', content: json(ChannelList) },
    ...authedErrors,
    403: forbidden,
    404: roomNotFound,
    409: errorResponse(
      '`CHANNEL_ORDER_STALE`: the list doesn’t match the room’s live channels of that type. Reload and retry.',
    ),
    422: errorResponse('Invalid type, or channelIds empty, too long, malformed, or repeated.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/channels/{channelId}',
  tags: ['channels'],
  summary: 'Delete a channel',
  description:
    'Owner or admin only. Soft-deletes the channel; its messages are kept but no longer reachable. Deleting a ' +
    'voice channel disconnects everyone in it. The last text channel of a room can’t be deleted. Broadcasts ' +
    '`channel:deleted` on `room:<roomId>`. Non-members get 404.' +
    limitNote +
    writeNote,
  request: { params: ChannelIdParams },
  responses: {
    204: { description: 'Deleted.' },
    ...authedErrors,
    403: forbidden,
    404: channelNotFound,
    409: errorResponse('`LAST_TEXT_CHANNEL`: this is the room’s only text channel.'),
    500: serverError,
  },
});
