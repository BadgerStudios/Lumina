import { useMutation } from "@tanstack/react-query";
import type { PollDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

/**
 * Voting.
 *
 * There is no `usePoll` query: a poll always arrives inside its message, and the live tallies come
 * over POLL_VOTE_UPDATE. A separate query would be a second source of truth for the same numbers,
 * and the two would disagree the moment a vote landed between a render and a refetch.
 */
export function useVotePoll() {
  return useMutation({
    mutationFn: ({ pollId, optionId }: { pollId: string; optionId: string }) =>
      api.post<PollDTO>(`/polls/${pollId}/vote`, { optionId }),
    onError: (e) => reportError(e, "Couldn't record your vote"),
  });
}
