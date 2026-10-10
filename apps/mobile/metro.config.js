// Workspace packages use TypeScript-style relative specifiers ("./errors.js") that
// point at .ts sources. Metro does not map .js to .ts, so retry without the extension.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the unmodified specifier (a real .js file).
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
