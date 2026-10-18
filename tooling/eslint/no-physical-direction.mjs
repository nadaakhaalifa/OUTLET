// Forbids physical-direction style props in the RTL-aware UI code (apps/mobile, packages/ui-native).
// Use logical props instead: start/end, marginStart/marginEnd, paddingStart/paddingEnd,
// borderStartWidth/borderEndWidth, borderTopStartRadius ..., and textAlign "auto" (or the kit Text `align`).
// Escape hatch for the rare legitimate physical case (FlashList columns, glyph art, the kit's own
// start/end -> left/right mapping): put a comment containing `physical-direction: <reason>` on the
// property's line or the line above it.
const ALWAYS = new Set([
  "marginLeft", "marginRight", "paddingLeft", "paddingRight",
  "borderLeftWidth", "borderRightWidth", "borderLeftColor", "borderRightColor", "borderLeft", "borderRight",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
]);
const POSITIONAL = new Set(["left", "right"]);
const STYLE_SIBLINGS = new Set(["position", "top", "bottom", "width", "height", "flex", "zIndex", "transform"]);
const MARKER = "physical-direction:";

function keyName(node) {
  if (node.computed) return null;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return null;
}

function hasPhysicalAlign(value) {
  if (!value) return false;
  if (value.type === "Literal") return value.value === "left" || value.value === "right";
  if (value.type === "ConditionalExpression") return hasPhysicalAlign(value.consequent) || hasPhysicalAlign(value.alternate);
  if (value.type === "TSAsExpression" || value.type === "TSSatisfiesExpression") return hasPhysicalAlign(value.expression);
  return false;
}

function inStyleContext(node, ctx) {
  const obj = node.parent;
  if (obj?.type === "ObjectExpression" && obj.properties.some((p) => p.type === "Property" && STYLE_SIBLINGS.has(keyName(p) ?? ""))) return true;
  const ancestors = ctx.sourceCode.getAncestors(node);
  for (const a of ancestors) {
    if (a.type === "JSXAttribute" && a.name?.name === "style") return true;
    if (a.type === "Property" && keyName(a) !== null && /style/i.test(keyName(a))) return true;
    if (a.type === "VariableDeclarator" && a.id?.type === "Identifier" && /style/i.test(a.id.name)) return true;
    if (a.type === "CallExpression" && a.callee.type === "MemberExpression" && a.callee.object.name === "StyleSheet") return true;
  }
  return false;
}

export default {
  rules: {
    "no-physical-direction": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          physical: "Physical-direction style `{{name}}` breaks RTL. Use the logical start/end equivalent, or add a `physical-direction: <reason>` comment.",
          align: "textAlign '{{value}}' is physical. Use \"auto\" (or the kit Text `align` prop), or add a `physical-direction: <reason>` comment.",
        },
      },
      create(context) {
        const sc = context.sourceCode;
        const allowed = (node) => {
          const from = node.loc.start.line - 1;
          const to = node.loc.end.line;
          return sc.getAllComments().some((c) => c.value.includes(MARKER) && c.loc.end.line >= from && c.loc.start.line <= to);
        };
        return {
          Property(node) {
            const name = keyName(node);
            if (name === null) return;
            if (ALWAYS.has(name)) {
              if (!allowed(node)) context.report({ node, messageId: "physical", data: { name } });
            } else if (POSITIONAL.has(name)) {
              if (inStyleContext(node, context) && !allowed(node)) context.report({ node, messageId: "physical", data: { name } });
            } else if (name === "textAlign" && hasPhysicalAlign(node.value)) {
              if (!allowed(node)) context.report({ node, messageId: "align", data: { value: "left/right" } });
            }
          },
        };
      },
    },
  },
};
