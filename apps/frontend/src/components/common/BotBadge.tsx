/** Small tag next to a name — "Bot" for a real bot account (User.isBot, see roadmap Phase 3),
 * "Webhook" for a message with no real author at all (MessageDTO.webhookId, see Phase 5). Kept
 * as one component since they're visually identical, just different text — a webhook message
 * genuinely has no User behind it at all, so it deliberately isn't labeled "Bot" too, which
 * would misrepresent it as a real authenticated account. */
export function BotBadge({ label = "Bot" }: { label?: string }) {
  return (
    <span className="rounded bg-accent px-1 py-0.5 align-middle font-mono text-[0.6rem] font-bold uppercase leading-none text-white">
      {label}
    </span>
  );
}
