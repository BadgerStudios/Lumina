import { TicketQueue } from "../../components/tickets/TicketQueue";

/**
 * The moderator queue inside the staff suite.
 *
 * A wrapper rather than the queue mounted directly on the route, because the same component is also
 * rendered inside the owner console — which supplies its own chrome. Keeping the page separate from
 * the queue is what lets both host it without either one owning the other's layout.
 */
export function StaffTicketsPage() {
  return <TicketQueue status="ACTIVE" />;
}
