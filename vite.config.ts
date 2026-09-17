import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import tsconfigPaths from "vite-tsconfig-paths";
import PluginConfig from "./src/plugin.config";

const yaml = (obj: any) => [
  `ce_prefix: ${obj.ce_prefix}`,
  `identifier: ${obj.identifier}`,
  `name: ${JSON.stringify(obj.name)}`,
  `version: ${obj.version}`,
  `author: ${obj.author}`,
  `repo: ${obj.repo}`,
  `pluginKitVersion: ${obj.pluginKitVersion}`,
  `SettingsElement: ${obj.SettingsElement}`,
  `icon: ${obj.icon || "icon.png"}`,
  "entry:",
  "  plugin.js:",
  "    type: main"
].join("\n") + "\n";

function ciderPluginRuntime(): Plugin {
  return {
    name: "cider-plugin-runtime",
    buildStart() {
      this.emitFile({ fileName: "plugin.yml", type: "asset", source: yaml(PluginConfig) });
    },
    configureServer(server) {
      server.middlewares.use("/plugin.js", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.end("import plugin from '/src/main.ts';\nexport default plugin;\n");
      });

      server.middlewares.use("/plugin.yml", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/yaml; charset=utf-8");
        res.end(yaml(PluginConfig));
      });

      server.middlewares.use("/health", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          service: "canvas-for-cider-plugin-dev",
          canvasApi: "https://spotify-canvas-for-cider-api.vercel.app"
        }));
      });
    }
  };
}

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    cssInjectedByJsPlugin(),
    vue({ template: { compilerOptions: { isCustomElement: tag => tag.startsWith("cider-") } } }),
    ciderPluginRuntime()
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    lib: { entry: "src/main.ts", fileName: "plugin", formats: ["es"] },
    target: ["es2020", "chrome108"]
  },
  server: {
    host: "127.0.0.1",
    port: 3058,
    strictPort: true,
    cors: true
  },
  define: {
    "process.env": JSON.stringify({ cider: "4" })
  }
});
