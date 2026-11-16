"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * "É comigo" — `POST /api/v1/conversations/:id/passagens/aceitar` (migration 9401).
 *
 * Usado pelo cabeçalho da conversa e pelo aviso `handoff` da Central. Invalida
 * as passagens (o cartão e o próprio botão), a conversa (ela mudou de dono) e a
 * Central (o aviso foi resolvido): `passagens_de_atendimento` não está na
 * publicação do realtime, então quem aceita não pode depender de carona.
 */
export function useAceitarPassagem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) =>
      apiClient.post<{ data: { ja_aceita: boolean } }>(
        `/api/v1/conversations/${conversationId}/passagens/aceitar`,
        {},
      ),
    onError: (err, conversationId) => {
      qc.invalidateQueries({ queryKey: ["passagens", conversationId] });
      showApiError(err);
    },
    onSuccess: (_data, conversationId) => {
      qc.invalidateQueries({ queryKey: ["passagens", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["agent-inbox"] });
    },
  });
}
