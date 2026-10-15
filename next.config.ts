import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Lets a tunnel (ngrok) reach the dev server, for testing on a phone.
  allowedDevOrigins: (process.env.PUBLIC_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
