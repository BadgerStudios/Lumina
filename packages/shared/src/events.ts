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
  // Soundboard trigger. Carries only a sound id: the server looks the clip up, checks the sender is
  // actually in the voice channel they claim, and relays. A client never gets to name the URL that
  // everyone else's browser will fetch and play.
  SOUNDBOARD_PLAY: "soundboard:play",
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
  /** A channel's permission overwrites changed. Carries only the channelId: the recipients have
   * different effective permissions from each other, so there is no single payload that is
   * correct for the whole room — each client refetches and gets its own answer. */
  CHANNEL_OVERWRITES_UPDATE: "channel:overwrites:update",
  THREAD_CREATE: "thread:create",
  THREAD_UPDATE: "thread:update",
  /** Something landed in the recipient's Activity inbox. Carries nothing — the client refetches
   * its own inbox, so the payload can't leak across a shared room. */
  INBOX_NEW: "inbox:new",
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
  // A change to the recipient's OWN platform role, pushed to `user:${userId}`.
  //
  // platformRole only ever arrived with a login or refresh response, so being promoted to staff was
  // invisible until the person signed out and back in (or, after useRoleSync, until they happened
  // to tab away and back). The API let them into /api/staff/* immediately while their own UI still
  // showed them nothing and redirected them out of the suite — the confusing half-state where the
  // server and the client disagree about who you are.
  PLATFORM_ROLE_UPDATE: "platform:role-update",
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
  // Live poll tallies, broadcast to the message's channel/DM room. Carries the whole re-serialized
  // PollDTO plus the voterId, because "votedByMe" cannot be baked into a payload that one
  // serialization has to serve to a whole room — the recipient sets its own flag by comparing
  // voterId to itself, exactly the pattern REACTION_ADD already uses.
  POLL_VOTE_UPDATE: "poll:vote-update",
  // Link unfurls, which arrive after the message did (the fetch happens out-of-band on the worker,
  // never in the send path). Carries the messageId and the finished embeds so a client can patch
  // the message it already rendered.
  MESSAGE_EMBEDS_UPDATE: "message:embeds-update",
  // Relayed soundboard trigger, sent to everyone in the voice room INCLUDING the presser, so all
  // clients start the clip from the same event rather than the presser starting it locally and
  // everyone else a round-trip later.
  SOUNDBOARD_PLAY: "soundboard:play",
  // A slash-command invocation or component click awaiting this bot's answer. Pushed to the bot's
  // own `user:${botUserId}` room — bots hold a normal authenticated socket like any other client.
  INTERACTION_CREATE: "interaction:create",
} as const;
