import { z } from 'zod';
import { ProfileSummary } from '../contracts/http/rooms.js';

/** The public.profiles columns a ProfileSummary needs, as selects and embeds return them. */
export const ProfileRow = z.object({ id: z.guid(), display_name: z.string(), avatar_url: z.string().nullable() });
export type ProfileRow = z.infer<typeof ProfileRow>;
export const PROFILE_COLUMNS = 'id, display_name, avatar_url';

/** Lowercased id; a stored avatar that isn't a valid https URL is dropped rather than failing the request. */
export function toProfileSummary(profile: ProfileRow): z.infer<typeof ProfileSummary> {
  const avatar = ProfileSummary.shape.avatarUrl.safeParse(profile.avatar_url);
  return { id: profile.id.toLowerCase(), displayName: profile.display_name, avatarUrl: avatar.success ? avatar.data : null };
}
