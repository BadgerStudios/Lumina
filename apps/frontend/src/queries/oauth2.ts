import { useMutation, useQuery } from "@tanstack/react-query";
import type { OAuthAuthorizeInfoDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";

export interface OAuthAuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
}

/** Backs the consent screen (routes/OAuthAuthorizeRoute.tsx) — validates client_id/redirect_uri/
 * scope server-side (see modules/oauth2/service.ts) before any "Approve" button is shown. */
export function useOAuthAuthorizeInfo(params: OAuthAuthorizeParams | undefined) {
  const query = params
    ? `client_id=${encodeURIComponent(params.clientId)}&redirect_uri=${encodeURIComponent(params.redirectUri)}&scope=${encodeURIComponent(params.scope)}`
    : "";
  return useQuery({
    queryKey: ["oauthAuthorizeInfo", params?.clientId, params?.redirectUri, params?.scope],
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
