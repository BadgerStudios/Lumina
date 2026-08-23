import { useMutation, useQuery } from "@tanstack/react-query";
import type { OAuthAuthorizeInfoDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";

export interface OAuthAuthorizeParams {
  clientId: string;
  /** Absent for scope=bot, which has no redirect leg. */
  redirectUri?: string;
  scope: string;
  state?: string;
  /** scope=bot: the permission bitfield the install link is asking for, as a decimal string. */
  permissions?: string;
  /** scope=bot: the server being installed into (chosen on the consent screen). */
  guildId?: string;
}

export interface BotInstallResult {
  serverId: string;
  botUserId: string;
  grantedPermissions: string;
  alreadyPresent: boolean;
}

/** Backs the consent screen (routes/OAuthAuthorizeRoute.tsx) — validates client_id/redirect_uri/
 * scope server-side (see modules/oauth2/service.ts) before any "Approve" button is shown. */
export function useOAuthAuthorizeInfo(params: OAuthAuthorizeParams | undefined) {
  const query = params
    ? [
        `client_id=${encodeURIComponent(params.clientId)}`,
        `scope=${encodeURIComponent(params.scope)}`,
        ...(params.redirectUri ? [`redirect_uri=${encodeURIComponent(params.redirectUri)}`] : []),
        ...(params.permissions ? [`permissions=${encodeURIComponent(params.permissions)}`] : []),
      ].join("&")
    : "";
  return useQuery({
    queryKey: ["oauthAuthorizeInfo", params?.clientId, params?.redirectUri, params?.scope, params?.permissions],
    queryFn: () => api.get<OAuthAuthorizeInfoDTO>(`/oauth2/authorize?${query}`),
    enabled: !!params,
    retry: false,
  });
}

export function useApproveOAuthAuthorization() {
  return useMutation({
    mutationFn: (params: OAuthAuthorizeParams) =>
      api.post<{ redirectUrl: string }>("/oauth2/authorize", {
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        scope: params.scope,
        state: params.state,
      }),
  });
}

/** scope=bot approves an INSTALL: the same endpoint, but it adds the bot to the chosen server and
 * returns what was granted rather than a redirect to follow. */
export function useInstallBot() {
  return useMutation({
    mutationFn: (params: OAuthAuthorizeParams & { guildId: string }) =>
      api.post<BotInstallResult>("/oauth2/authorize", {
        clientId: params.clientId,
        scope: params.scope,
        permissions: params.permissions,
        guildId: params.guildId,
      }),
  });
}
