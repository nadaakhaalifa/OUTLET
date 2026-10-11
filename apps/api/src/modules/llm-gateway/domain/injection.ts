/**
 * Injection heuristics (LLM01). They reduce risk and produce a signal; the real defences are the
 * schema-constrained output, catalog-joined ids and the absence of write tools.
 */
const PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above|system)/i,
  /forget\s+(?:everything|all|your)\s+(?:above|previous|instructions?)/i,
  /(?:reveal|print|show|repeat)\s+(?:your\s+|the\s+)?(?:system\s+prompt|instructions|hidden\s+prompt)/i,
  /you\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:system|assistant|developer)\s*:/i,
  /<\s*\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /\bset\s+(?:the\s+)?price\b/i,
  /\bprice\s+(?:is\s+|to\s+|=\s*)?\d+\s*(?:egp|le|جنيه|ج\.م)/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
  // Arabic
  /تجاهل\s+(?:كل\s+|جميع\s+)?(?:التعليمات|الأوامر|ما\s+سبق)/u,
  /تجاهل\s+التعليمات\s+السابقة/u,
  /انس[ىي]?\s+(?:كل\s+)?(?:التعليمات|ما\s+سبق)/u,
  /(?:اظهر|اكشف|اطبع)\s+(?:لي\s+)?(?:التعليمات|البرومبت|رسالة\s+النظام)/u,
  /انت\s+الان\s+/u,
  /(?:غير|اجعل)\s+السعر/u,
  /السعر\s+(?:هو\s+)?\d+\s*(?:جنيه|ج\.م)/u,
];

export interface InjectionVerdict {
  readonly flagged: boolean;
  readonly matches: number;
}

export function detectInjection(text: string): InjectionVerdict {
  const t = text.normalize("NFKC");
  let matches = 0;
  for (const p of PATTERNS) if (p.test(t)) matches++;
  return { flagged: matches > 0, matches };
}

export const NEUTRALISED = "[removed: instruction-like text]";
