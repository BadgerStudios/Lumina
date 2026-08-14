import { CreateServerModal } from "./CreateServerModal";
import { CreateChannelModal } from "./CreateChannelModal";
import { InviteModal } from "./InviteModal";
import { RoleEditorModal } from "./RoleEditorModal";
import { ServerSettingsModal } from "./ServerSettingsModal";
import { ChannelSettingsModal } from "./ChannelSettingsModal";
import { LeaderboardModal } from "./LeaderboardModal";
import { EventsModal } from "./EventsModal";
import { GameModal } from "./GameModal";
import { GroupDMSettingsModal } from "./GroupDMSettingsModal";
import { NotificationSettingsModal } from "./NotificationSettingsModal";
import { UserSettingsModal } from "./UserSettingsModal";

/** All modals mount permanently and gate their own visibility off useUIStore. NOTE: despite
 * what this comment used to say, mounting-once does NOT reset a modal's local form state on
 * reopen for free — `useState(initialValue)` only ever runs on first mount. Every modal here
 * that edits an existing entity (RoleEditorModal, ServerSettingsModal, ChannelSettingsModal)
 * needs an explicit useEffect keyed on `open` + the entity's id to resync, or it'll show stale
 * data from whatever it last edited (a real bug found and fixed this way in ServerSettingsModal
 * — see its own comment). */
export function ModalRoot() {
  return (
    <>
      <CreateServerModal />
      <CreateChannelModal />
      <InviteModal />
      <RoleEditorModal />
      <ServerSettingsModal />
      <ChannelSettingsModal />
      <LeaderboardModal />
      <EventsModal />
      <GameModal />
      <GroupDMSettingsModal />
      <NotificationSettingsModal />
      <UserSettingsModal />
    </>
  );
}
