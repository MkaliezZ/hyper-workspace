import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.runtime/**",
        "**/.data/**",
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3100",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (_error, _req, res) => {
            if ("writeHead" in res && !res.headersSent && !res.writableEnded)
              res
                .writeHead(503, {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "no-store",
                })
                .end(
                  JSON.stringify({
                    message:
                      "服务正在重连，请稍后重试；已提交操作请先核对原回执。",
                  }),
                );
          });
        },
      },
    },
  },
});
