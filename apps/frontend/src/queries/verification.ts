import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

/** Public config the client needs before login (Turnstile site key, whether Persona is available). */
export interface VerificationConfig {
  turnstileSiteKey: string | null;
  personaConfigured: boolean;
}

export function useVerificationConfig() {
  return useQuery({
    queryKey: ["verification", "config"],
    queryFn: () => api.get<VerificationConfig>("/verification/config"),
    staleTime: 5 * 60 * 1000,
  });
}

export interface VerificationStatus {
  assuranceLevel: "SELF_DECLARED" | "DEVICE_DECLARED" | "DOCUMENT_VERIFIED";
  assuranceSource: string | null;
  band: string | null;
  identityVerified: boolean;
  isMinor: boolean;
  hasAgeOnRecord: boolean;
  personaStatus: string | null;
  manualReviewPending: boolean;
  personaConfigured: boolean;
  /** This account must clear identity verification (new signups only — older accounts are grandfathered). */
  verificationRequired: boolean;
}

export function useVerificationStatus() {
  return useQuery({
    queryKey: ["verification", "status"],
    queryFn: () => api.get<VerificationStatus>("/verification/status"),
    staleTime: 15_000,
  });
}

export type StartVerificationResult =
  | { mode: "persona"; inquiryId: string; link: string | null }
  | { mode: "manual_review" };

/** Begin the document/identity step: Persona while budget lasts, else the selfie manual-review path. */
export function useStartVerification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<StartVerificationResult>("/verification/persona/start"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["verification", "status"] }),
  });
}

/**
 * Submit age verification: a selfie AND a photo of a government ID, in one request.
 *
 * Both are required by the server. Sending them together rather than as two uploads means there is
 * never a half-finished submission sitting on disk with one identity image in it and nothing
 * driving its deletion.
 */
export function useSubmitVerification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ selfie, idDocument }: { selfie: File; idDocument: File }) => {
      const form = new FormData();
      form.append("selfie", selfie);
      form.append("idDocument", idDocument);
      return api.postForm<{ status: string; reviewId: string; retentionHours: number }>(
        "/verification/manual-review",
        form,
      );
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["verification", "status"] }),
  });
}

// ---- owner suite ---------------------------------------------------------------------------------

export interface AgeReview {
  id: string;
  createdAt: string;
  selfieUrl: string | null;
  idDocumentUrl: string | null;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    birthDate: string | null;
    ageBracket: string | null;
  };
}

export function useAgeReviews() {
  return useQuery({
    queryKey: ["verification", "owner", "age-reviews"],
    queryFn: () => api.get<AgeReview[]>("/verification/owner/age-reviews"),
    staleTime: 15_000,
  });
}

export function useDecideAgeReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: "ADULT" | "MINOR"; note?: string }) =>
      api.post(`/verification/owner/age-reviews/${input.id}/decide`, {
        decision: input.decision,
        note: input.note,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["verification", "owner", "age-reviews"] }),
  });
}
