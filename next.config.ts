import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  allowedDevOrigins: ["192.168.1.40", "192.168.1.9", "192.168.1.7"],
};

export default nextConfig;
