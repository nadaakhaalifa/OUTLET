# Cloud infrastructure and data residency for Outlet NK (Egypt, as of 2026-11-06)

## Which hyperscaler regions are in or near Egypt in 2026?

### Takeaway
I found no AWS, Azure, Google Cloud or Oracle region inside Egypt as of November 2026. The only public-cloud region in the country is Huawei Cloud Cairo, launched in 2024. AWS was only in talks with the government in May–July 2026.

### Cited Findings
- (2026) On 21 May 2026, AWS met Egypt's Communications Minister about expanding AI and cloud infrastructure. The reports name no Egypt region or Local Zone. — [Arab Finance](https://arabfinance.com/en/news/newdetails/aws-eyes-broader-expansion-in-egypt-ai-cloud-computing-infrastructure); [Zawya](https://www.zawya.com/en/economy/north-africa/aws-eyes-broader-expansion-in-egypts-ai-cloud-computing-infrastructure-wt3va2py)
- (2019) Microsoft and Telecom Egypt announced a network point of presence in Egypt, not a datacenter region. — [Zawya](https://www.zawya.com/en/press-release/microsoft-collaborates-with-telecom-egypt-to-announce-its-first-cloud-network-in-egypt-triu14y1)
- (2022) A Microsoft Q&A moderator said Azure has no datacenter in Egypt and suggested nearby regions. This is the latest direct statement I found. — [Microsoft Learn Q&A](https://learn.microsoft.com/en-us/answers/a/705312)
- (May 2024) Huawei Cloud launched its Cairo Region, described as the first public cloud region in Egypt and Huawei's 33rd worldwide. Telecom Egypt hosts it in a Tier III data center at Smart Village. — [Huawei Cloud press release](https://www.huaweicloud.com/intl/en-us/news/20240523155312706.html); [Intelligent CIO](https://www.intelligentcio.com/africa/2024/05/23/huawei-cloud-announces-cairo-region/)
- (2026, vendor source) A vendor buyer's guide says hyperscalers mostly serve Egyptian enterprises from European regions. Treat it as indicative only. — [MomentumX](https://momentumx.cloud/egypt-cloud-providers-2026/)
- (2026) A search covering Oracle, Google Cloud Egypt and an AWS Cairo Local Zone returned nothing for any of them. — [Zenlayer Cairo page appeared instead](https://www.zenlayer.com/lp/city/cairo)

### Inferences
- The nearest hyperscaler options are AWS me-central-1 (UAE), AWS me-south-1 (Bahrain), AWS il-central-1 (Tel Aviv), GCP me-central1 (Doha), me-central2 (Dammam) and me-west1 (Tel Aviv), Azure UAE North, and Oracle Dubai/Abu Dhabi/Jeddah. These come from general knowledge and were not re-verified in this pass. Any of them means personal data leaves Egypt, which needs a PDPC transfer licence.
- Cairo latency: from general knowledge, round trips are roughly 40–70 ms to the Gulf and 50–70 ms to Frankfurt or Milan. **Unverified**: measure with a Cairo probe (RIPE Atlas, cloudping) before deciding.

### Gaps
- I did not check the official region pages of each hyperscaler, so the absence of an Egypt region is inferred from search results, not confirmed from the providers.
- I found no measured Cairo latency data.

## Which Egypt-hosted cloud and data-center providers exist, and how mature are they?

### Takeaway
In-country options are a mix of colocation, telco and state facilities plus one hyperscale-style public cloud (Huawei). Khazna and Gulf Data Hub are large announced builds with unconfirmed completion. Cloudflare has a Cairo PoP.

### Cited Findings
- (2023 announcement) Khazna (UAE) and Benya Group plan a USD 250m, 25 MW hyperscale data center at Maadi Technology Park, with completion targeted about 3 years later. I found no confirmation that it is live. — [The National](https://www.thenationalnews.com/business/technology/2023/05/08/abu-dhabis-khazna-to-open-250m-data-centre-in-egypt-amid-global-acquisition-plan); [Enterprise](https://enterpriseam.com/egypt/2023/05/09/khazna-data-centers-benya-to-build-usd-250-mn-hyperscale-data-center-in-cairo/)
- Elsewedy Data Centers and Gulf Data Hub signed an MoU for about USD 2.1bn across three complexes. Status unknown. — [DCPost MEA](https://www.dcpostmea.com/tag/emirati-gulf-data-hub)
- (Apr 2026) Telecom Egypt runs a regional data center complex and denied reports that it would turn it into a "cash-generating asset". — [Baxtel Cairo news](https://baxtel.com/news/data-centers/cairo)
- (2024) The Government Data and Cloud Computing Center in the New Administrative Capital launched on 28 April 2024. Egypt's Cloud First Policy (2024) applies to government entities. — [Masaar](https://masaar.net/en/cloud-computing-in-egypt-impacts-on-resources-and-rights/); [Dig.watch](https://dig.watch/?p=221906)
- (2015) Cloudflare opened its Cairo PoP (CAI) with Telecom Egypt. Egypt is reportedly served from Cairo only. — [Cloudflare blog](https://blog.cloudflare.com/cairo); [know-2nth primer](https://know-2nth.pages.dev/explainers/tech/cloudflare/edge-africa-me)
- Zenlayer has a Cairo site offering IP transit. Its own FAQ says bare metal is not generally available there. — [Zenlayer](https://cloud.zenlayer.com/datacenters/cairo)
- NTRA authorises and regulates data centers and cloud service providers. — [Baker McKenzie](https://resourcehub.bakermckenzie.com/en/resources/cloud-compliance-center/emea/egypt)

### Inferences
- Huawei Cloud Cairo is the only in-country option with managed PostgreSQL-class services, but they are GaussDB/RDS, and pgvector support is **unverified**. The other options mean self-operating Kubernetes, Postgres and Redis on telco or colocation infrastructure, which brings a heavy ops burden.

### Gaps
- I found nothing on Raya Data Center, Orange Business Egypt, Vodafone Egypt cloud, or an Akamai Cairo PoP in this pass.
- The operational status of Khazna and Gulf Data Hub is unknown.

## What do PDPL and its executive regulations require for cross-border transfer? Does the CBE require localization?

### Takeaway
Transfers abroad need a separate PDPC transfer licence. The fee is reportedly 50% of the controller/processor licence fee, with a 90-day review. Exact EGP fees were not found. I found no confirmed CBE localization rule for a non-bank merchant.

### Cited Findings
- (Nov 2025) The executive regulations (Decision 816/2025) were issued with a one-year compliance countdown, ending in November 2026. — [CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins); [Digital Policy Alert](https://digitalpolicyalert.org/event/36521-executive-regulations-of-the-personal-data-protection-law-decision-no-816-of-2025-including-operational-license-requirement-entered-into-force)
- A separate PDPC licence or permit is needed before transferring data abroad, whether temporarily or permanently. The application must state the destination, storage locations and security measures. The PDPC reviews within 90 days, and the fee is 50% of the controller/processor licence fee (Art. 27 as reported). — [Legal500](https://www.legal500.com/guides/hot-topic/strategic-challenges-and-opportunities-in-cross-border-data-transfers-under-egypts-personal-data-protection-regime); [Tsaaro](https://tsaaro.com/blogs/egypts-pdpl-is-finally-live-why-november-2026-is-a-hard-stop-for-compliance); [Clyde & Co (Jan 2026)](https://www.clydeco.com/fr/insights/2026/01/egypt-regulatory-update-on-data-privacy)
- Sources disagree on the decree number: Chambers cites "81 of 2025" while others say 816/2025. — [Chambers](https://chambers.com/articles/a-first-look-at-egypt-s-personal-data-protection-executive-regulations)
- On the CBE, Baker McKenzie says Egyptian law is silent on where financial institutions using cloud must store data, subject to exceptions. A January 2026 blog claims 2025 CBE guidance requires banks to keep a local "data mirror". This is **unverified**. — [Baker McKenzie](https://resourcehub.bakermckenzie.com/en/resources/cloud-compliance-center/emea/egypt/topics/permissibility-of-cloud); [MomentumX](https://momentumx.cloud/banking-cloud-egypt/)
- Digital-bank licence applicants must disclose where data is stored and processed. — [Legal Community MENA](https://legalcommunitymena.com/?p=185246)

### Inferences
- Outlet NK is a merchant, not a CBE licensee, and card data stays with the PSP (SAQ A). CBE localization therefore likely applies to the PSPs, not to Outlet NK. **VERIFY with counsel.**
- Any hyperscaler hosting outside Egypt means a transfer licence plus a transfer impact assessment (TIA), which is at least about 90 days of lead time. That lead time affects the launch date.

### Gaps
- I found no published 2025–26 PDPC guidance documents, licence category tables or EGP fee amounts. I also found nothing on whether the PDPC has whitelisted any countries (for example the UAE) as adequate.

## Approximate monthly cost: AWS UAE vs Egypt local, and managed alternatives

### Takeaway
I found no sourced 2026 price sheets. The figures below are **unverified estimates from general pricing knowledge (2025 list prices)** and should be priced with each vendor's calculator.

### Cited Findings
- I found no citable 2026 pricing for AWS me-central-1, Huawei Cairo or Egyptian telco cloud.

### Inferences (all unverified estimates)
- **AWS me-central-1, small production setup.** The UAE region typically lists about 10–20% above us-east-1. Estimated components:
  - RDS PostgreSQL Multi-AZ db.t4g/m7g.large: about USD 250–450.
  - 2–4 Fargate/ECS tasks: about USD 80–200.
  - ElastiCache small: about USD 50–120.
  - S3 plus CloudFront at small volume: about USD 20–80.
  - ALB plus WAF: about USD 40–80.
  - NAT gateway: about USD 40–80.
  - Total: roughly **USD 500–1,000/month**, plus a self-hosted Typesense VM (about USD 50–150).
- **Egypt local (Huawei Cairo or telco IaaS).** Likely similar or lower list prices, but fewer managed services and more ops staff time. I found no data to support a figure.
- **Managed PaaS** (regions from general knowledge, **unverified for 2026**):
  - Vercel: global edge, with function regions including Frankfurt (fra1) and Dubai (dxb1, reported).
  - Supabase: no Egypt or UAE region known; nearest are EU (Frankfurt) and possibly Middle East.
  - Neon: AWS regions, mostly US/EU/APAC.
  - Render: Frankfurt.
  - Fly.io: had Johannesburg and Frankfurt, but not Cairo or the Gulf.
  - Railway: EU West.
  - None of these offers Egypt hosting, so they all count as cross-border for P2/P3 data. They are suitable only for public catalog and front-end rendering that holds no personal data.

### Gaps
- No real quotes. Get AWS Pricing Calculator output for me-central-1 and a quote from Huawei Cloud Egypt or Telecom Egypt.

## Recommended pattern and trade-offs

### Takeaway
Use a split, "hybrid (c)"-style plane:
- **P2/P3 identity, address, order and ledger data in Egypt.** Huawei Cloud Cairo or a Telecom Egypt / Tier III colocation with self-managed Postgres.
- **Public catalog, images and search outside Egypt.** These can be global (CDN/Cloudflare with the Cairo PoP, Vercel for the Next.js front end).

The alternative is a single AWS me-central-1 region with a PDPC transfer licence plus TIA. That is simpler to operate but depends on licence approval of up to 90 days or more.

### Cited Findings
- A transfer licence is required for any data leaving Egypt (see above). — [Legal500](https://www.legal500.com/guides/hot-topic/strategic-challenges-and-opportunities-in-cross-border-data-transfers-under-egypts-personal-data-protection-regime)
- Huawei Cairo is a live in-country region on a Telecom Egypt Tier III facility. — [Huawei Cloud](https://www.huaweicloud.com/intl/en-us/news/20240523155312706.html)
- Cloudflare serves Egypt from its Cairo PoP. — [Cloudflare blog](https://blog.cloudflare.com/cairo)

### Inferences
- **Option A: everything in AWS UAE plus a licence.**
  - Pros: managed multi-AZ Postgres, mature tooling, lowest ops load.
  - Cons: licence dependency, regulatory risk if it is refused, and a possible USD/AED cost exposure.
- **Option B: all in Egypt.**
  - Pros: no transfer licence for core data.
  - Cons: managed-service maturity, pgvector availability, DR within one country, ops headcount, and a geopolitical/vendor concern with Huawei for some partners.
- **Option C: hybrid** (recommended default pending counsel).
  - Pros: the core stays residency-safe, and catalog/CDN/search get global performance.
  - Cons: two planes to operate. Strict data classification is needed so that no P2 data reaches the global plane, including logs, analytics, Sentry and LLM calls.
- Even under C, processors such as Sentry, PostHog, LLM vendors and email/SMS providers that are hosted abroad still count as transfers. Self-host them or license them.

### Gaps
- Whether the PDPC treats encrypted-only or tokenized data abroad as a transfer.
- Whether a UAE adequacy decision exists.
- Huawei Cairo service catalog details (managed PostgreSQL version, pgvector, Redis, multi-AZ).
