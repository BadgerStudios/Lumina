import { MessageSquare } from "lucide-react";
import { DMSidebar } from "../components/layout/DMSidebar";

export function HomeRoute() {
  return (
    <>
      <DMSidebar variant="primary" />
      <div className="hidden flex-1 flex-col items-center justify-center gap-3 text-signal-faint md:flex">
        <MessageSquare size={48} />
        <p className="text-sm">Select a conversation, or pick a server from the rail on the left.</p>
      </div>
    </>
  );
}
