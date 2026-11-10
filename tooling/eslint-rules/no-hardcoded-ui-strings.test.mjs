import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";
import tseslint from "typescript-eslint";
import rule from "./no-hardcoded-ui-strings.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const languageOptions = {
  parser: tseslint.parser,
  ecmaVersion: 2022,
  sourceType: "module",
  parserOptions: { ecmaFeatures: { jsx: true } },
};
const filename = "packages/ui-web/src/X.tsx";

new RuleTester({ languageOptions }).run("no-hardcoded-ui-strings", rule, {
  valid: [
    { code: "const a = <p>{t('nav.explore')}</p>;", filename },
    { code: "const a = <button aria-label={t('common.close')}>×</button>;", filename },
    { code: "const a = <span>+</span>;", filename },
    { code: "const a = <span> · </span>;", filename },
    { code: "const a = <span>12 / 34</span>;", filename },
    { code: "const a = <span>٣٠٪</span>;", filename },
    { code: "const a = <img alt={name} src='x.png' />;", filename },
    { code: "const a = <input placeholder={t('search.placeholder')} />;", filename },
    { code: "const a = <input placeholder='' />;", filename },
    { code: "const a = <div className='card' id='x' data-testid='thing' />;", filename },
    { code: "const a = <input label='...' title='|' />;", filename },
    { code: "const a = <input aria-label={`${x}`} />;", filename },
    { code: "const a = <input aria-label />;", filename },
    { code: "const a = <input aria-label={7} />;", filename },
    { code: "const a = <svg:path title='' />;", filename },
    { code: "const a = <p>Hello</p>;", filename: "packages/i18n/src/anything.tsx" },
  ],
  invalid: [
    { code: "const a = <p>Explore stores</p>;", filename, errors: [{ messageId: "text" }] },
    { code: "const a = <p>استكشف المتاجر</p>;", filename, errors: [{ messageId: "text" }] },
    { code: "const a = <p>\n  Bag ({n})\n</p>;", filename, errors: [{ messageId: "text" }] },
    { code: "const a = <b>EGP {n}</b>;", filename, errors: [{ messageId: "text" }] },
    { code: "const a = <input placeholder='Search' />;", filename, errors: [{ messageId: "attr" }] },
    { code: "const a = <button aria-label='إغلاق'>x</button>;", filename, errors: [{ messageId: "attr" }, { messageId: "text" }] },
    { code: "const a = <img alt={'Jacket front view that is very long indeed'} />;", filename, errors: [{ messageId: "attr" }] },
    { code: "const a = <Field label=\"Phone\" />;", filename, errors: [{ messageId: "attr" }] },
    { code: "const a = <Card title={`Deals`} />;", filename, errors: [{ messageId: "attr" }] },
    { code: "const a = <a title='Open 24h' />;", filename, errors: [{ messageId: "attr" }] },
  ],
});
