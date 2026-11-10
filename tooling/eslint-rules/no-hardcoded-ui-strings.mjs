// Flags user-facing text written directly in JSX (BUILD-PROMPT section 2: i18n keys only, AR required).
// Reports JSX text and string-literal values of label, title, placeholder, aria-label and alt that contain a letter
// (Latin, Arabic or any script). Punctuation, symbols, digits and whitespace are allowed ("+", "×", "·", "1/3").
// Text must come from t("key") or a value; packages/i18n holds the catalogs and is exempt.

const ATTRS = new Set(["label", "title", "placeholder", "aria-label", "alt"]);
const HAS_LETTER = /\p{L}/u;

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow hard-coded user-facing strings in JSX; use i18n keys" },
    schema: [],
    messages: {
      text: "Hard-coded UI text {{preview}}: use t('key') from @outlet/i18n.",
      attr: "Hard-coded UI string in `{{name}}` ({{preview}}): use t('key') from @outlet/i18n.",
    },
  },
  create(context) {
    if (/(^|[\\/])packages[\\/]i18n[\\/]/.test(context.filename)) return {};
    const preview = (s) => JSON.stringify(s.trim().length > 24 ? `${s.trim().slice(0, 24)}…` : s.trim());
    return {
      JSXText(node) {
        if (HAS_LETTER.test(node.value)) context.report({ node, messageId: "text", data: { preview: preview(node.value) } });
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !ATTRS.has(node.name.name) || !node.value) return;
        let value = node.value;
        if (value.type === "JSXExpressionContainer") value = value.expression;
        let text = null;
        if (value.type === "Literal" && typeof value.value === "string") text = value.value;
        else if (value.type === "TemplateLiteral" && value.expressions.length === 0) text = value.quasis.map((q) => q.value.cooked ?? "").join("");
        if (text !== null && HAS_LETTER.test(text)) {
          context.report({ node: node.value, messageId: "attr", data: { name: node.name.name, preview: preview(text) } });
        }
      },
    };
  },
};
