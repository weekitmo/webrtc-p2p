import { defineConfig } from "vite";
import os from "node:os";
import vue from "@vitejs/plugin-vue";
import ReactivityTransform from "@vue-macros/reactivity-transform/vite";
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), ReactivityTransform()],
  server: {
    host: "0.0.0.0",
  },
  define: {
    __IP__: JSON.stringify(getIpAddress()),
  },
  base: "/web/rtc"
});

function getIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const key in interfaces) {
    const iface = interfaces[key];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (
        alias.family === "IPv4" &&
        alias.address !== "127.0.0.1" &&
        !alias.internal
      ) {
        return alias.address;
      }
    }
  }
  return `localhost`
}
