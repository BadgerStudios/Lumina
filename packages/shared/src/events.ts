// Socket.IO event name constants — shared between backend emitters/handlers and frontend listeners.

export const ClientEvents = {
  CHANNEL_JOIN: "channel:join",
  CHANNEL_LEAVE: "channel:leave",
  MESSAGE_SEND: "message:send",
  MESSAGE_EDIT: "message:edit",
  MESSAGE_DELETE: "message:delete",
  REACTION_ADD: "reaction:add",
  REACTION_REMOVE: "reaction:remove",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  PRESENCE_SET: "presence:set",
  // Mesh WebRTC signaling relay (realtime/handlers/voice.ts) — the server never touches media,
  // it only relays offer/answer/ICE payloads between specific socket ids and tracks room
  // membership. See roadmap Phase 8 for why mesh (not an SFU) was the deliberate choice.
  VOICE_JOIN: "voice:join",
  VOICE_LEAVE: "voice:leave",
  VOICE_SIGNAL: "voice:signal",
} as const;

export const ServerEvents = {
  MESSAGE_CREATE: "message:create",
  MESSAGE_UPDATE: "message:update",
  MESSAGE_DELETE: "message:delete",
  REACTION_ADD: "reaction:add",
  REACTION_REMOVE: "reaction:remove",
  TYPING_UPDATE: "typing:update",
  PRESENCE_UPDATE: "presence:update",
  MEMBER_JOIN: "member:join",
  MEMBER_LEAVE: "member:leave",
  MEMBER_UPDATE: "member:update",
  ROLE_CREATE: "role:create",
  ROLE_UPDATE: "role:update",
  ROLE_DELETE: "role:delete",
  CHANNEL_CREATE: "channel:create",
  CHANNEL_UPDATE: "channel:update",
  CHANNEL_DELETE: "channel:delete",
  SERVER_UPDATE: "server:update",
  SERVER_DELETE: "server:delete",
  DM_CREATE: "dm:create",
  // Rename or participant add/remove on a group DM (modules/dm/routes.ts) — always carries the
  // full re-serialized DMConversationDTO rather than a delta, same "just replace it" approach
  // MEMBER_UPDATE/CHANNEL_UPDATE already use.
  DM_UPDATE: "dm:update",
  // Sent only to the removed user (modules/dm/routes.ts DELETE /:id/participants/:userId) so
  // their DM list can drop the conversation — everyone else gets the normal DM_UPDATE re-serialize.
  DM_PARTICIPANT_REMOVED: "dm:participant-removed",
  // Read-receipt update (modules/dm/routes.ts PATCH /:id/read) — carries the full re-serialized
  // DMConversationDTO (its readStates array) rather than a bare {userId, messageId} delta, same
  // "just replace it" approach as DM_UPDATE.
  DM_READ_UPDATE: "dm:read-update",
  NOTIFICATION_MENTION: "notification:mention",
  // A staff moderation decision (or a transcode completing) on one of the recipient's own uploaded
  // videos — pushed only to `user:${authorId}`, carrying the owner-form VideoDTO with status and
  // rejectionReason. Without this an uploader has no way to learn their video was approved or
  // refused short of reopening the app and re-polling.
  VIDEO_STATUS_UPDATE: "video:status-update",
  // Sent to the person who filed a report once staff close the ticket, carrying the outcome and the
  // moderator's note. Pushed to `user:${reporterId}` so it lands wherever they're signed in.
  REPORT_RESOLVED: "report:resolved",
  VOICE_PARTICIPANT_JOINED: "voice:participant-joined",
  VOICE_PARTICIPANT_LEFT: "voice:participant-left",
  VOICE_SIGNAL: "voice:signal",
  // Pushed to `user:${addresseeId}` (create) or both parties' `user:` rooms (status change) —
  // see modules/friends/service.ts. Frontend just invalidates its friends/friendRequests
  // queries on receipt (see socket/useSocketEvents.ts) rather than hand-patching, same as
  // NOTIFICATION_MENTION above; the existing poll interval stays as a fallback.
  FRIEND_REQUEST_CREATE: "friend-request:create",
  FRIEND_REQUEST_UPDATE: "friend-request:update",
  // Broadcast to the whole server room (not just the voice room itself) so members can see who's
  // in a voice channel without joining it — see realtime/handlers/voice.ts.
  VOICE_ROSTER_UPDATE: "voice:roster-update",
  // Broadcast to EVERY connected socket the moment a deploy finishes publishing.
  //
  // Each client already knows how to check whether it is out of date — the Android app compares
  // version codes, the web app compares its entry-script hash, desktop asks electron-updater. The
  // problem this solves is purely *when*: those checks run on launch and then every 15-30 minutes,
  // so a fix could sit shipped and unseen for half an hour on a client that was already open.
  //
  // The payload deliberately carries no version numbers. It is a nudge meaning "re-run your own
  // check now", so a client that cannot be updated (or is already current) simply finds nothing,
  // and no client has to trust a number the server asserted about a platform it isn't running on.
  APP_UPDATE_AVAILABLE: "app:update-available",
} as const;
