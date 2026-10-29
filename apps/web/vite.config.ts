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
    proxy: { "/api": { target: "http://127.0.0.1:3100", changeOrigin: true } },
  },
});
