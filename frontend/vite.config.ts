
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react()],

    define: {
      global: "globalThis",
    },

    server: {
      host: "127.0.0.1",
      port: 5173,

      proxy: {
        "/api": {
          target: environment.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001",
          changeOrigin: true,
        },
      },
    },
  };
});
