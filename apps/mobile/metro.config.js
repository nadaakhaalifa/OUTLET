// Two Metro fixes for this pnpm monorepo:
//
// 1. Workspace packages use TypeScript-style relative specifiers ("./errors.js") that point at .ts
//    sources. Metro does not map .js to .ts, so retry without the extension.
//
// 2. React Native modules MUST exist exactly once at runtime. pnpm auto-installs peer dependencies
//    into every workspace package that declares them (packages/ui-native gets its own copy of
//    react-native, reanimated, gesture-handler, svg and the Expo modules), so shared components would
//    load a second copy and the native bridge fails ("undefined is not a function"). Pin these
//    packages to the app's copy no matter which workspace package imports them.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appRoot = __dirname;

/** Native-module packages that must exist exactly once at runtime. Prefix rules cover every Expo and React Native package (a second copy of expo-modules-core or expo-asset shows up as "Cannot find native module"). */
const SINGLETON_NAMES = new Set(["react", "react-dom", "scheduler", "@shopify/flash-list", "react-is"]);
const SINGLETON_PREFIXES = ["expo", "@expo/", "react-native", "@react-native", "@react-native-", "@react-navigation/"];
const isSingleton = (pkg) => SINGLETON_NAMES.has(pkg) || SINGLETON_PREFIXES.some((p) => pkg === p || pkg.startsWith(p.endsWith("/") ? p : p));

/** Package name of a bare specifier ("react-native/Libraries/x" -> "react-native"; "@expo/vector-icons/Ionicons" -> "@expo/vector-icons"). */
function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the unmodified specifier (a real .js file).
    }
  }
  const pkg = packageNameOf(moduleName);
  if (pkg !== null && isSingleton(pkg)) {
    // Resolve as if the import came from a file inside the app, so every package shares one copy.
    // If the app does not have the package (a workspace package's own private dependency), fall back.
    try {
      return context.resolveRequest({ ...context, originModulePath: path.join(appRoot, "package.json") }, moduleName, platform);
    } catch {
      // Fall through to the default resolution.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
