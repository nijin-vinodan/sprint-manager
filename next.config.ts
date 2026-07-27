import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    tsconfigPath: "./tsconfig.next.json",
  },
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
