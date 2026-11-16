"use client";
/**
 * QUANDO NINGUÉM ACEITA A PASSAGEM (migration 9401) — a configuração do
 * escalonamento, por organização (`settings.escalonamento_de_passagem`).
 *
 * Mora nesta tela, e não em Configurações › Atendimento, pelo mesmo motivo do
 * aviso de transferência: ela decide quem recebe mensagem no WhatsApp e por
 * quanto tempo, e isso é decisão de `admin`, o papel desta página. Salva por
 * server action própria (`definirEscalonamentoDaPassagem`) — misturar com o
 * "Salvar" do aviso faria uma gravação depender da outra.
 *
 * O reserva e o responsável por etiqueta são escolhidos da equipe ATIVA
 * (`agent`+, convite aceito, não revogado); a action confere de novo.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirEscalonamentoDaPassagem } from "@/app/actions/settings/definirEscalonamentoDaPassagem";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import type { EscalonamentoDaPassagem as Config } from "@/lib/escalacao/escalonamento-da-passagem";

/** Valor do Select para "ninguém" — o Radix não aceita `value=""` num item. */
const NINGUEM = "__ninguem__";

function inteiro(texto: string, padrao: number): number {
  const n = Number.parseInt(texto, 10);
  return Number.isFinite(n) ? n : padrao;
}

export function EscalonamentoDaPassagem({ inicial }: { inicial: Config }) {
  const t = useT();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [config, setConfig] = useState<Config>(inicial);
  const [rotas, setRotas] = useState<Array<{ etiqueta: string; quem: string }>>(
    Object.entries(inicial.rota_por_etiqueta).map(([etiqueta, quem]) => ({ etiqueta, quem })),
  );
  const membros = useTeamMembers();

  const equipe = useMemo(
    () =>
      (membros.data?.data ?? [])
        .filter((m) => !m.revoked_at && m.accepted_at && ["agent", "manager", "admin"].includes(m.role))
        .map((m) => ({ id: m.user_id, nome: m.full_name || m.email || m.user_id })),
    [membros.data],
  );

  function definirBackup(de: string, para: string) {
    setConfig((c) => {
      const backup = { ...c.backup };
      if (para === NINGUEM) delete backup[de];
      else backup[de] = para;
      return { ...c, backup };
    });
  }

  function salvar() {
    const rota: Record<string, string> = {};
    for (const r of rotas) {
      if (r.etiqueta.trim() && r.quem) rota[r.etiqueta.trim().toLowerCase()] = r.quem;
    }
    startTransition(async () => {
      const r = await definirEscalonamentoDaPassagem({ ...config, rota_por_etiqueta: rota });
      if (!r.ok) {
        toast.error(t(r.error ?? "Não foi possível salvar."));
        return;
      }
      toast.success(t("Opção salva."));
      router.refresh();
    });
  }

  return (
    <Card className="space-y-5 p-4" data-testid="escalonamento-da-passagem">
      <div className="flex items-start gap-3">
        <Switch
          id="escalonamento_ligado"
          checked={config.ligado}
          disabled={pendente}
          onCheckedChange={(ligado) => setConfig((c) => ({ ...c, ligado }))}
        />
        <div className="space-y-1">
          <Label htmlFor="escalonamento_ligado" className="text-sm font-medium">
            {t("Lembrar quando ninguém aceita um atendimento")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quando a IA passa uma conversa para a equipe, o responsável precisa tocar em Aceitar. Enquanto ninguém aceita, ele recebe lembretes na Central, no celular e, se o aviso no WhatsApp estiver ligado, no WhatsApp dele.",
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="urgente_minutos">{t("Urgente: lembrar a cada (minutos)")}</Label>
          <Input
            id="urgente_minutos"
            type="number"
            min={5}
            max={1440}
            value={config.urgente_minutos}
            onChange={(e) => setConfig((c) => ({ ...c, urgente_minutos: inteiro(e.target.value, c.urgente_minutos) }))}
          />
          <p className="text-xs text-muted-foreground">
            {t("Urgente é a conversa ou o negócio com a etiqueta urgente ou reclamação.")}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="escalar_apos">{t("Urgente: passar para o reserva depois de (lembretes)")}</Label>
          <Input
            id="escalar_apos"
            type="number"
            min={1}
            max={10}
            value={config.escalar_urgente_apos_lembretes}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                escalar_urgente_apos_lembretes: inteiro(e.target.value, c.escalar_urgente_apos_lembretes),
              }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="normal_minutos">{t("Normal: lembrar a cada (minutos)")}</Label>
          <Input
            id="normal_minutos"
            type="number"
            min={5}
            max={1440}
            value={config.normal_minutos}
            onChange={(e) => setConfig((c) => ({ ...c, normal_minutos: inteiro(e.target.value, c.normal_minutos) }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="max_lembretes">{t("Normal: máximo de lembretes")}</Label>
          <Input
            id="max_lembretes"
            type="number"
            min={1}
            max={10}
            value={config.max_lembretes}
            onChange={(e) => setConfig((c) => ({ ...c, max_lembretes: inteiro(e.target.value, c.max_lembretes) }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="silencio_inicio">{t("Sem WhatsApp a partir de (hora)")}</Label>
          <Input
            id="silencio_inicio"
            type="number"
            min={0}
            max={23}
            value={config.silencio.inicio}
            onChange={(e) =>
              setConfig((c) => ({ ...c, silencio: { ...c.silencio, inicio: inteiro(e.target.value, c.silencio.inicio) } }))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="silencio_fim">{t("Volta o WhatsApp às (hora)")}</Label>
          <Input
            id="silencio_fim"
            type="number"
            min={0}
            max={23}
            value={config.silencio.fim}
            onChange={(e) =>
              setConfig((c) => ({ ...c, silencio: { ...c.silencio, fim: inteiro(e.target.value, c.silencio.fim) } }))
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("No fuso da empresa. Nesse horário a Central e o celular continuam avisando; só o WhatsApp espera.")}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("Reserva de cada pessoa (só para urgentes)")}</p>
        {equipe.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Carregando a equipe…")}</p>
        ) : (
          <ul className="space-y-2">
            {equipe.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40 text-sm">{m.nome}</span>
                <Select value={config.backup[m.id] ?? NINGUEM} onValueChange={(v) => definirBackup(m.id, v)}>
                  <SelectTrigger className="w-full sm:w-72" aria-label={t("Reserva de {nome}").replace("{nome}", m.nome)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NINGUEM}>{t("Sem reserva")}</SelectItem>
                    {equipe
                      .filter((o) => o.id !== m.id)
                      .map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.nome}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("Responsável por etiqueta")}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            "Quando a conversa não tem dono nem negócio com dono, a etiqueta da conversa (ou do contato) decide quem responde. Sem nenhuma, o lembrete vai para a Central da equipe.",
          )}
        </p>
        <ul className="space-y-2">
          {rotas.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Input
                className="w-full sm:w-48"
                aria-label={t("Etiqueta")}
                placeholder={t("Etiqueta")}
                value={r.etiqueta}
                maxLength={40}
                onChange={(e) =>
                  setRotas((rs) => rs.map((x, j) => (j === i ? { ...x, etiqueta: e.target.value } : x)))
                }
              />
              <Select
                value={r.quem || undefined}
                onValueChange={(quem) => setRotas((rs) => rs.map((x, j) => (j === i ? { ...x, quem } : x)))}
              >
                <SelectTrigger className="w-full sm:w-72" aria-label={t("Responsável")}>
                  <SelectValue placeholder={t("Escolha quem responde")} />
                </SelectTrigger>
                <SelectContent>
                  {equipe.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRotas((rs) => rs.filter((_, j) => j !== i))}
              >
                {t("Remover")}
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setRotas((rs) => [...rs, { etiqueta: "", quem: "" }])}
        >
          {t("Adicionar etiqueta")}
        </Button>
      </div>

      <div>
        <Button type="button" disabled={pendente} onClick={salvar} data-testid="salvar-escalonamento">
          {t("Salvar")}
        </Button>
      </div>
    </Card>
  );
}
