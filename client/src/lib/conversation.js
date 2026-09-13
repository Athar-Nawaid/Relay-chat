/**
 * Conversation display helpers, shared by the sidebar and the thread header.
 *
 * Both used to compute presence independently with identical-looking code. One
 * source of truth means they cannot drift.
 */

/** DMs have no stored title — they are named after the other person. */
export function titleOf(conversation, meId) {
  if (!conversation) return '';
  if (conversation.type === 'group') return conversation.title ?? 'Group';
  const other = otherMembers(conversation, meId)[0];
  return other?.displayName ?? other?.username ?? 'Direct message';
}

export function otherMembers(conversation, meId) {
  return (conversation?.members ?? []).filter((m) => m.id !== meId);
}

/** A DM is "online" when the other person is. Groups do not show a status. */
export function isOnline(conversation, presence, meId) {
  return otherMembers(conversation, meId).some((m) => Boolean(presence[m.id]));
}
