// Flags `*` and `/` (and their compound assignments) when an operand is an identifier or member
// whose name contains amount|price|money|minor units. Money is bigint minor units: scale with the
// packages/money helpers (percentOf, allocate), never with native arithmetic.
const MONEY_NAME = /(amount|price|money|minorunits|minor$)/i;
const OPERATORS = new Set(["*", "/", "*=", "/="]);

function nameOf(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    if (!node.computed && node.property.type === "Identifier") return node.property.name;
    if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
      return node.property.value;
    }
    return undefined;
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression"
  ) {
    return nameOf(node.expression);
  }
  return undefined;
}

const isMoneyLike = (node) => {
  const name = nameOf(node);
  return name !== undefined && MONEY_NAME.test(name);
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow * and / on money-like identifiers; use packages/money helpers." },
    schema: [],
    messages: {
      floatMoney: "Do not use '{{op}}' on money-like value '{{name}}'. Use percentOf/allocate from packages/money.",
    },
  },
  create(context) {
    const check = (node, left, right) => {
      const hit = [left, right].find(isMoneyLike);
      if (hit && OPERATORS.has(node.operator)) {
        context.report({ node, messageId: "floatMoney", data: { op: node.operator, name: nameOf(hit) } });
      }
    };
    const isNumericCall = (callee) => {
      if (callee.type === "Identifier") return ["Number", "parseFloat", "parseInt"].includes(callee.name);
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.object.name === "Math"
      );
    };
    return {
      CallExpression(node) {
        if (!isNumericCall(node.callee)) return;
        const hit = node.arguments.find(isMoneyLike);
        if (hit) {
          context.report({ node, messageId: "floatMoney", data: { op: "numeric conversion", name: nameOf(hit) } });
        }
      },
      BinaryExpression: (node) => check(node, node.left, node.right),
      AssignmentExpression: (node) => check(node, node.left, node.right),
    };
  },
};
