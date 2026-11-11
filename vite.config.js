import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleApiRequest } from "./server/api.js";

import { startPaperWorker, stopPaperWorker } from "./server/paper/runtime.js";

function marketDataPlugin() {
  const middleware = (request, response, next) => {
    handleApiRequest(request, response)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  };
  return {
    name: "market-data-api",
    configureServer(server) {
      startPaperWorker();
      server.httpServer?.once("close", () => { stopPaperWorker(); });
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), marketDataPlugin()],
});
