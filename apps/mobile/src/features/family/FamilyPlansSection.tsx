import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Divider, ErrorState, Eyebrow, Reveal, Skeleton, Text, TextField, useTheme } from "../../ui";
import { getFeaturePorts } from "../../state/ports";
import { formatMoney, localizeDigits } from "../money-display";
import { newIdempotencyKey } from "../plus/idempotency";
import { formatCairoDate } from "../plus/model";
import {
  buildOwnerView, buildStudentView, canStartStudent, familyFailureState, isPlausibleEmail, validateInvite,
  type DisplayLocale, type FamilyPort, type FamilyScreenState, type FamilySnapshot, type SeatRowView,
} from "./model";

type Confirm = { readonly kind: "leave" } | { readonly kind: "remove"; readonly seatId: string } | null;

/**
 * Family group and student verification inside the Plus screen. It reads everything from the server and changes
 * nothing about the Plus paywall or the age gate: members below the Plus age policy are refused by the server and
 * the reason is shown as given.
 */
export function FamilyPlansSection(props: { port?: FamilyPort }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<FamilyPort>(() => props.port ?? getFeaturePorts().family, [props.port]);
  const [state, setState] = useState<FamilyScreenState>({ status: "loading" });
  const [phone, setPhone] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error" | "success"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const keys = useRef(new Map<string, string>());
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);
  const date = (ms: number) => formatCairoDate(ms, locale);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(familyFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  /** One idempotency key per logical attempt; a retry after a timeout replays it, success clears it. */
  const run = async (attempt: string, f: (key: string) => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const key = keys.current.get(attempt) ?? newIdempotencyKey();
    keys.current.set(attempt, key);
    try {
      const done = await f(key);
      keys.current.delete(attempt);
      if (done !== null) setMessage({ tone: "success", text: done });
      await load(true);
    } catch {
      setMessage({ tone: "error", text: t("family.actionFailed") });
    } finally {
      setBusy(false);
    }
  };

  const sendInvite = () => {
    setShowErrors(true);
    const v = validateInvite(phone, nickname);
    if (!v.ok) return;
    void run(`invite:${v.phone}`, async (key) => {
      const out = await port.invite(v.phone, v.nickname, key);
      if (out.kind === "invited") {
        setPhone(""); setNickname(""); setShowErrors(false);
        return t("family.invite.sent");
      }
      setMessage({ tone: "error", text: t(`family.invite.refused.${out.reason}`, { age: num(out.minAge ?? 21) }) });
      return null;
    });
  };

  const startStudent = () => {
    setShowErrors(true);
    if (!isPlausibleEmail(email)) return;
    void run("student", async (key) => {
      const out = await port.startStudentVerification("universityEmail", email.trim(), key);
      if (out.kind === "refused") {
        setMessage({ tone: "error", text: t(`family.student.refused.${out.reason}`) });
        return null;
      }
      setShowErrors(false);
      if (out.redirectUrl !== null) void Linking.openURL(out.redirectUrl).catch(() => undefined);
      return t("family.student.started");
    });
  };

  const inviteCheck = validateInvite(phone, nickname);
  const seatLabel = (r: SeatRowView) => r.seat.nickname ?? t("family.seat.unnamed", { n: num(r.seat.seatNo) });

  const renderFamily = (snap: FamilySnapshot) => {
    const f = snap.family;
    if (f === null) {
      return (
        <View style={{ gap: 8 }}>
          <Text variant="callout" secondary>
            {snap.familyPlan !== null
              ? t("family.none.withPlan", { seats: num(snap.familyPlan.seatLimit ?? 4), price: money(snap.familyPlan.price), period: t(`plus.period.${snap.familyPlan.interval}`) })
              : t("family.none.body")}
          </Text>
          <Text variant="caption" secondary>{t("family.none.note")}</Text>
        </View>
      );
    }
    if (f.role === "member") {
      const ending = f.seatEndAtMs ?? f.entitlementEndsAtMs;
      return (
        <View style={{ gap: 10 }}>
          <Text variant="callout">{f.status === "ACTIVE" && f.seatStatus === "ACTIVE" ? t("family.member.active") : t("family.member.ended")}</Text>
          {ending !== null ? <Text variant="caption" secondary>{t("family.member.endsOn", { date: date(ending) })}</Text> : null}
          {f.status === "ACTIVE" && f.seatStatus === "ACTIVE" ? (
            confirm?.kind === "leave" ? (
              <View style={{ gap: 8 }}>
                <Text variant="caption" secondary>{t("family.leave.explain")}</Text>
                <Button variant="destructive" title={t("family.leave.confirm")} loading={busy} disabled={busy} onPress={() => void run("leave", async (key) => { await port.leave(key); setConfirm(null); return t("family.leave.done"); })} />
                <Button variant="ghost" title={t("family.leave.keep")} onPress={() => setConfirm(null)} />
              </View>
            ) : (
              <Button variant="secondary" title={t("family.leave.action")} disabled={busy} onPress={() => setConfirm({ kind: "leave" })} />
            )
          ) : null}
        </View>
      );
    }
    const v = buildOwnerView(f);
    return (
      <View style={{ gap: 12 }}>
        <Text variant="callout" secondary>{t("family.owner.seats", { held: num(v.seatsHeld), limit: num(v.seatLimit) })}</Text>
        <View>
          {v.rows.map((r, i) => (
            <Reveal key={r.seat.id} index={i}>
              <View style={{ paddingVertical: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.hairline }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{r.seat.role === "owner" ? t("family.seat.you") : seatLabel(r)}</Text>
                  <Text variant="caption" secondary>
                    {r.seat.status === "INVITED" && r.seat.inviteExpiresAtMs !== null
                      ? t("family.seat.invitedUntil", { date: date(r.seat.inviteExpiresAtMs) })
                      : t(`family.seat.status.${r.seat.status}`)}
                  </Text>
                </View>
                {r.canRevoke ? (
                  <Button variant="ghost" title={t("family.seat.revoke")} disabled={busy} onPress={() => void run(`revoke:${r.seat.id}`, async (key) => { await port.revokeInvite(r.seat.id, key); return t("family.seat.revoked"); })} />
                ) : null}
                {r.canRemove ? (
                  confirm?.kind === "remove" && confirm.seatId === r.seat.id ? (
                    <View style={{ gap: 8 }}>
                      <Text variant="caption" secondary>{t("family.remove.explain")}</Text>
                      <Button variant="destructive" title={t("family.remove.confirm")} loading={busy} disabled={busy} onPress={() => void run(`remove:${r.seat.id}`, async (key) => { await port.removeMember(r.seat.id, key); setConfirm(null); return t("family.remove.done"); })} />
                      <Button variant="ghost" title={t("family.remove.keep")} onPress={() => setConfirm(null)} />
                    </View>
                  ) : (
                    <Button variant="ghost" title={t("family.seat.remove")} disabled={busy} onPress={() => setConfirm({ kind: "remove", seatId: r.seat.id })} />
                  )
                ) : null}
              </View>
            </Reveal>
          ))}
        </View>
        {v.canInvite ? (
          <View style={{ gap: 10 }}>
            <Eyebrow>{t("family.invite.heading")}</Eyebrow>
            <TextField
              label={t("family.invite.phone")}
              value={phone}
              keyboardType="phone-pad"
              onChangeText={setPhone}
              {...(showErrors && !inviteCheck.ok ? { error: t(`family.invite.error.${inviteCheck.error}`) } : {})}
            />
            <TextField label={t("family.invite.nickname")} value={nickname} maxLength={40} onChangeText={setNickname} helper={t("family.invite.nicknameHelper")} />
            <Button variant="secondary" title={t("family.invite.send")} loading={busy} disabled={busy} onPress={sendInvite} />
            <Text variant="caption" secondary>{t("family.invite.note")}</Text>
          </View>
        ) : (
          <Text variant="caption" secondary>{f.status === "ACTIVE" ? t("family.owner.full") : t("family.owner.ended")}</Text>
        )}
      </View>
    );
  };

  const renderStudent = (snap: FamilySnapshot) => {
    const v = buildStudentView(snap.student);
    const partner = (name: string | null) => name ?? t("family.student.partnerFallback");
    return (
      <View style={{ gap: 10 }}>
        {v.kind === "verified" ? (
          <>
            <Text variant="callout">
              {t("family.student.verifiedBy", { provider: partner(v.verifier) })}
              {v.validUntilMs !== null ? ` ${t("family.student.validUntil", { date: date(v.validUntilMs) })}` : ""}
            </Text>
            <Text variant="caption" secondary>{t(v.priceApplies ? "family.student.priceApplies" : "family.student.priceNotApplied")}</Text>
          </>
        ) : null}
        {v.kind === "pending" ? <Banner tone="info" message={t("family.student.pending")} /> : null}
        {v.kind === "rejected" ? <Banner tone="warning" message={t("family.student.rejected")} /> : null}
        {v.kind === "expired" ? <Banner tone="warning" message={t("family.student.expired")} /> : null}
        {v.kind === "none" ? (
          <Text variant="callout" secondary>
            {snap.studentPlan !== null
              ? t("family.student.noneWithPlan", { price: money(snap.studentPlan.price), period: t(`plus.period.${snap.studentPlan.interval}`) })
              : t("family.student.none")}
          </Text>
        ) : null}
        {canStartStudent(snap.student) ? (
          <View style={{ gap: 10 }}>
            <TextField
              label={t("family.student.email")}
              value={email}
              keyboardType="email-address"
              onChangeText={setEmail}
              helper={t("family.student.emailHelper")}
              {...(showErrors && !isPlausibleEmail(email) ? { error: t("family.student.emailInvalid") } : {})}
            />
            <Button variant="secondary" title={t(v.kind === "none" ? "family.student.start" : "family.student.restart")} loading={busy} disabled={busy} onPress={startStudent} />
            <Text variant="caption" secondary>{t("family.student.privacy")}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  if (state.status === "loading") {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={t("family.loading")} style={{ gap: 10 }}>
        <Skeleton width="40%" height={14} /><Skeleton height={56} radius={14} />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <ErrorState
        offline={state.offline}
        title={t(state.offline ? "family.offlineTitle" : "family.errorTitle")}
        description={t(state.offline ? "family.offlineBody" : "family.errorBody")}
        retryTitle={t("common.retry")}
        onRetry={() => void load()}
      />
    );
  }
  const snap = state.snapshot;
  return (
    <View style={{ gap: 20 }}>
      <Divider />
      <View style={{ gap: 10 }}>
        <Eyebrow>{t("family.eyebrow")}</Eyebrow>
        <Text variant="title1" accessibilityRole="header">{t("family.title")}</Text>
        {message !== null ? <Banner tone={message.tone} message={message.text} /> : null}
        {renderFamily(snap)}
      </View>
      <Divider />
      <View style={{ gap: 10 }}>
        <Eyebrow>{t("family.student.eyebrow")}</Eyebrow>
        <Text variant="title1" accessibilityRole="header">{t("family.student.title")}</Text>
        {renderStudent(snap)}
      </View>
    </View>
  );
}
