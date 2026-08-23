import { FriendsPane } from "../components/layout/FriendsPane";

/** Friends is a full pane now — the conversation list that used to sit beside it moved into the
 * nav deck, so this route no longer needs to render a sidebar of its own. */
export function FriendsRoute() {
  return <FriendsPane />;
}
