import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import tsconfigPaths from "vite-tsconfig-paths";
import PluginConfig from "./src/plugin.config";

const yaml = (obj: any) => [
  `ce_prefix: ${obj.ce_prefix}`,
  `identifier: ${obj.identifier}`,
  `name: ${JSON.stringify(obj.name)}`,
  `description: ${JSON.stringify(obj.description)}`,
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
        res.end(JSON.stringify({ ok: true, port: 3058, plugin: PluginConfig.identifier }));
      });

      server.middlewares.use("/api/canvas/check-spdc", (req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
        if (req.method !== "POST") return next();
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const { getToken } = await server.ssrLoadModule("/src/server/bitchord-auth.js");
            const parsed = JSON.parse(body || "{}");
            if (!parsed?.spDc) {
              res.statusCode = 200;
              return res.end(JSON.stringify({ valid: false, reason: "sp_dc-not-configured" }));
            }
            await getToken(String(parsed.spDc), { forceRefresh: true });
            console.log("[Canvas for Cider Server] sp_dc startup check: valid");
            res.statusCode = 200;
            res.end(JSON.stringify({ valid: true, reason: "ok" }));
          } catch (error: any) {
            const message = error?.message || String(error);
            const lower = message.toLowerCase();
            const reason = error?.code === 'BROWSER_UNAVAILABLE'
              ? 'chromium-browser-unavailable'
              : error?.code === 'MISSING_SP_DC'
                ? 'sp_dc-not-configured'
                : error?.code === 'INVALID_SP_DC'
                  ? 'sp_dc-invalid-or-expired'
                  : error?.code === 'SPOTIFY_ACCESS_RESTRICTED'
                    ? 'spotify-access-restricted'
                    : lower.includes('authentication') || lower.includes('401') || lower.includes('403') || lower.includes('400')
                      ? 'spotify-authentication-failed'
                      : message;
            console.warn("[Canvas for Cider Server] sp_dc startup check failed", { status: error?.response?.status ?? null, reason });
            res.statusCode = 200;
            res.end(JSON.stringify({ valid: false, reason, message }));
          }
        });
      });

      server.middlewares.use("/api/canvas/resolve", (req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
        if (req.method !== "POST") return next();
        console.log("[Canvas for Cider Server] HTTP POST /api/canvas/resolve");
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          try {
            const { resolveCanvas } = await server.ssrLoadModule("/src/server/spotify.ts");
            const result = await resolveCanvas(JSON.parse(body || "{}"));
            console.log("[Canvas for Cider Server] HTTP 200 /api/canvas/resolve", {
              reason: result?.reason,
              spotifyTrackId: result?.spotifyTrackId,
              score: result?.score,
              hasCanvasUrl: Boolean(result?.canvasUrl)
            });
            res.statusCode = 200;
            res.end(JSON.stringify(result));
          } catch (error: any) {
            console.error("[Canvas for Cider Server] HTTP 502 /api/canvas/resolve", error);
            res.statusCode = 502;
            res.end(JSON.stringify({ reason: error?.message || String(error) }));
          }
        });
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
