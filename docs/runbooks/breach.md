# Runbook: personal data breach (PDPL)

Owner: DPO. Backup: CTO. Status: draft for owner review. Not legal advice; every legal step is tagged VERIFY BEFORE LAUNCH.

## Clock

The spec (B1) requires notice to the PDPC within **72 hours**, then to affected individuals within **3 days**. VERIFY BEFORE LAUNCH with counsel: when the clock starts (awareness versus confirmation), whether the 3 days run from the PDPC notice or from awareness, and the exact content the PDPC requires. Until confirmed, treat the clock as starting at the moment anyone at Z-OUTLET has reasonable grounds to believe a breach occurred. Record that timestamp as T0.

| Step | Target | Owner |
|---|---|---|
| Detect and open incident (Sev1, see incident-response.md) | immediately | On-call |
| Contain | as fast as possible, before triage completes | Incident commander |
| Triage and scope | T0 + 4 h | Incident commander, DPO |
| DPO decision (notify or not) | T0 + 24 h at the latest | DPO |
| PDPC notice | T0 + 72 h hard limit, aim for T0 + 48 h | DPO |
| Subject notice | 3 days (VERIFY the start), aim to send the same day as the PDPC notice | DPO, Support lead |
| Post-mortem | within 5 business days | Incident commander |

## 1. Detect

Sources: alerts, audit-log anomalies, seller or courier report, security researcher, a shopper complaint, PSP or cloud provider notice. Anyone who suspects a breach pages the on-call and the DPO. Do not wait for certainty.

## 2. Contain

- Revoke affected credentials and tokens, rotate secrets, disable the affected feature flag or endpoint.
- Preserve evidence: snapshot logs and the audit log (hash-chained, append-only); do not delete or edit.
- Do not "fix" the data in place before a copy is taken.

## 3. Triage (T0 + 4 h)

Fill the breach register entry (Privacy dashboard):

- What happened, when, how detected, still ongoing.
- Data classes affected (P1 to P3 per the data inventory), counts, jurisdictions, whether data was encrypted or pseudonymised and whether keys were exposed.
- Systems and processors involved (PSP, courier, SMS, cloud, LLM vendor, sellers).
- Whether payment card data is involved (PSP tokenised; if PAN exposure is suspected, escalate under B8).
- Likely harm to individuals (identity theft, financial loss, safety from address and phone exposure, minors).
- Whether a processor or seller must notify us, or we must notify a controller.

## 4. DPO decision step

The DPO records one of the following in the register, with reasoning, a timestamp and their name:

1. **Notify PDPC and subjects.** Default when personal data was accessed, disclosed, lost or altered and harm is not clearly negligible.
2. **Notify PDPC only.** When subject notice is judged not required. VERIFY BEFORE LAUNCH what the law permits here; do not use without counsel.
3. **No notification, document only.** For example data was demonstrably unintelligible to the recipient. Requires counsel sign-off.
4. **Undetermined, notify provisionally.** Send an initial PDPC notice with what is known and supplement later. Preferred over missing the deadline.

If the DPO is unavailable, the deputy named in the on-call roster decides; absence never delays the 72 h limit.

## 5. Notify the PDPC

Use the PDPC channel and form (VERIFY BEFORE LAUNCH: channel, form and language). Content, adapt to the PDPC form:

- Nature of the breach and categories and approximate number of people and records.
- DPO contact details.
- Likely consequences.
- Measures taken and proposed.
- Reasons for any delay beyond 72 h.

## 6. Notify subjects (3 days)

Channels: in-app message and the shopper's verified channel (SMS or email, transactional, no consent needed because it is a legal notice; VERIFY). Arabic is the primary language; always send both.

### Template, Arabic

> الموضوع: إشعار هام بشأن بياناتك الشخصية
>
> عزيزي/عزيزتي {{first_name}}،
>
> نكتب إليك لنبلغك بحادث أمني أثّر على بعض بياناتك الشخصية لدى Z-OUTLET.
>
> **ما الذي حدث:** {{what_happened}}
> **تاريخ الحادث واكتشافه:** {{date_occurred}} / {{date_discovered}}
> **البيانات المتأثرة:** {{data_categories}}
> **ما نوصي بأن تفعله:** {{recommended_actions}}
> **ما الذي فعلناه:** {{our_actions}}
>
> للاستفسار يمكنك التواصل مع مسؤول حماية البيانات على {{dpo_contact}}. نعتذر عن هذا الحادث.
>
> فريق Z-OUTLET

### Template, English

> Subject: Important notice about your personal data
>
> Dear {{first_name}},
>
> We are writing to tell you about a security incident that affected some of your personal data held by Z-OUTLET.
>
> **What happened:** {{what_happened}}
> **When it happened and when we found it:** {{date_occurred}} / {{date_discovered}}
> **Data affected:** {{data_categories}}
> **What we recommend you do:** {{recommended_actions}}
> **What we have done:** {{our_actions}}
>
> You can contact our Data Protection Officer at {{dpo_contact}}. We apologise for this incident.
>
> The Z-OUTLET team

Template rules: plain language, no speculation, no blame, no marketing, state only facts confirmed at send time, and do not include the affected data itself. Arabic text must be reviewed by a native speaker and counsel before first use. Placeholders in double braces are filled from the register.

## 7. Post-mortem and follow-up

- Blameless post-mortem within 5 business days; root cause, timeline against the clock above, what slowed the decision.
- Update the data inventory, threat model and this runbook. Add a regression test or alert.
- Close the register entry with all notice timestamps.
- Quarterly tabletop exercise using this runbook; record the result and fixes.

## Open items for the owner

- VERIFY BEFORE LAUNCH: clock start, PDPC channel and form, subject-notice exemptions, who the DPO and deputy are, whether sellers must be notified, and the language and content requirements.
- The DPO role does not exist yet; this runbook cannot be exercised until it does.
