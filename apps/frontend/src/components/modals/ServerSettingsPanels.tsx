import { useEffect, useState } from "react";
import type { ServerDTO } from "@lumina/shared";
import { useChannels } from "../../queries/channels";
import { useUpdateServer } from "../../queries/servers";

/**
 * The Moderation and Community panels of server settings.
 *
 * Split out of `ServerSettingsModal.tsx` rather than added to it: that file was already handling
 * seven tabs in one component, and these add a further dozen controls. Nothing here is clever — it
 * is a settings form — so the value is in keeping the modal readable, not in the abstraction.
 *
 * Every control saves on change rather than behind a Save button. That is the same pattern as the
 * rest of this modal, and it matters for a settings screen an operator is likely to tweak one thing
 * in and close.
 */

interface PanelProps {
  server: ServerDTO;
  serverId: string;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-signal-faint">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-signal-dim">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mb-4 flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span>
        <span className="block text-sm font-medium text-signal">{label}</span>
        <span className="block text-xs leading-relaxed text-signal-dim">{hint}</span>
      </span>
    </label>
  );
}

const SELECT_CLASS =
  "w-full rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal focus:border-accent focus:outline-none";

/** Verification level and the explicit-content filter. */
export function ModerationPanel({ server, serverId }: PanelProps) {
  const update = useUpdateServer(serverId);
  const save = (patch: Record<string, unknown>) => update.mutate(patch);

  return (
    <div>
      <Field
        label="Verification level"
        hint="Applies to posting, and is enforced on the server — not just shown here. Owners and anyone with Manage Server are exempt, so raising this can't lock you out of your own server."
      >
        <select
          className={SELECT_CLASS}
          value={server.verificationLevel}
          onChange={(e) => save({ verificationLevel: e.target.value })}
        >
          <option value="NONE">None — anyone can post</option>
          <option value="LOW">Low — must have a verified email</option>
          <option value="MEDIUM">Medium — verified email, account older than 5 minutes</option>
          <option value="HIGH">High — the above, and 10 minutes in this server</option>
        </select>
      </Field>

      <Field
        label="Explicit media filter"
        hint="Which members' attachments are scanned. Members with a role are usually the ones you trust, which is why the middle option exists."
      >
        <select
          className={SELECT_CLASS}
          value={server.explicitContentFilter}
          onChange={(e) => save({ explicitContentFilter: e.target.value })}
        >
          <option value="DISABLED">Don't scan anything</option>
          <option value="MEMBERS_WITHOUT_ROLES">Scan members without a role</option>
          <option value="ALL_MEMBERS">Scan everyone</option>
        </select>
      </Field>

      <Field
        label="Default notifications for new members"
        hint="Only decides the starting point. A member who has set their own preference keeps it."
      >
        <select
          className={SELECT_CLASS}
          value={server.defaultNotificationLevel}
          onChange={(e) => save({ defaultNotificationLevel: e.target.value })}
        >
          <option value="ALL">All messages</option>
          <option value="MENTIONS">Only @mentions</option>
          <option value="NONE">Nothing</option>
        </select>
      </Field>
    </div>
  );
}

/** Description, vanity invite, rules channel, system messages, and the inactive voice channel. */
export function CommunityPanel({ server, serverId }: PanelProps) {
  const update = useUpdateServer(serverId);
  const { data: channels } = useChannels(serverId);
  const save = (patch: Record<string, unknown>) => update.mutate(patch);

  const textChannels = (channels ?? []).filter((c) => c.type === "TEXT");
  const voiceChannels = (channels ?? []).filter((c) => c.type === "VOICE");

  // Local state so typing doesn't fire a request per keystroke; committed on blur.
  const [description, setDescription] = useState(server.description ?? "");
  const [vanity, setVanity] = useState(server.vanityCode ?? "");
  useEffect(() => setDescription(server.description ?? ""), [server.description]);
  useEffect(() => setVanity(server.vanityCode ?? ""), [server.vanityCode]);

  return (
    <div>
      <Toggle
        label="Show in Discover"
        hint="List this server on the public Discover page, where any adult on Lumina can find and join it without an invite. Off by default — nobody is listed without choosing to be."
        checked={server.discoverable}
        onChange={(v) => save({ discoverable: v })}
      />

      <Field label="Description" hint="Shown on the invite page before someone joins.">
        <textarea
          rows={3}
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            const next = description.trim();
            if (next !== (server.description ?? "")) save({ description: next || null });
          }}
          className="w-full resize-none rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal focus:border-accent focus:outline-none"
          placeholder="What is this server for?"
        />
      </Field>

      <Field
        label="Custom invite link"
        hint="Letters, numbers and hyphens. This shares a namespace with generated invite codes, so a code already in use will be rejected."
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-signal-faint">/invite/</span>
          <input
            value={vanity}
            onChange={(e) => setVanity(e.target.value)}
            onBlur={() => {
              const next = vanity.trim().toLowerCase();
              if (next !== (server.vanityCode ?? "")) save({ vanityCode: next || null });
            }}
            className="w-full rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal focus:border-accent focus:outline-none"
            placeholder="my-server"
          />
        </div>
      </Field>

      <Field
        label="Rules channel"
        hint="Linked from the invite page so people can read the rules before joining."
      >
        <select
          className={SELECT_CLASS}
          value={server.rulesChannelId ?? ""}
          onChange={(e) => save({ rulesChannelId: e.target.value || null })}
        >
          <option value="">No rules channel</option>
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="mb-5 border-t border-hairline pt-5">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-signal-faint">
          System messages
        </h4>
        <Toggle
          label="Welcome new members"
          hint="Posts in the system channel when someone joins."
          checked={server.sysJoinMessages}
          onChange={(v) => save({ sysJoinMessages: v })}
        />
        <Toggle
          label="Announce when members leave"
          hint="Off by default — on a busy server this is mostly noise, and it can single people out."
          checked={server.sysLeaveMessages}
          onChange={(v) => save({ sysLeaveMessages: v })}
        />
        <Toggle
          label="Celebrate server boosts"
          hint="Posts when someone boosts the server."
          checked={server.sysBoostMessages}
          onChange={(v) => save({ sysBoostMessages: v })}
        />
      </div>

      <div className="border-t border-hairline pt-5">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-signal-faint">
          Inactive voice
        </h4>
        <Field
          label="Inactive channel"
          hint="Members idle in voice are moved here rather than appearing active. Voice channels only."
        >
          <select
            className={SELECT_CLASS}
            value={server.afkChannelId ?? ""}
            onChange={(e) => save({ afkChannelId: e.target.value || null })}
          >
            <option value="">No inactive channel</option>
            {voiceChannels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inactive timeout">
          <select
            className={SELECT_CLASS}
            value={String(server.afkTimeoutSec)}
            onChange={(e) => save({ afkTimeoutSec: Number(e.target.value) })}
          >
            <option value="60">1 minute</option>
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="1800">30 minutes</option>
            <option value="3600">1 hour</option>
          </select>
        </Field>
      </div>
    </div>
  );
}
