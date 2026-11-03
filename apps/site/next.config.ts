import type { NextConfig } from "next";

const config: NextConfig = {
  // The API package ships TypeScript source with NodeNext-style ".js"
  // import specifiers; transpile it and map .js -> .ts during resolution.
  // Turbopack has no equivalent, so dev/build run with --webpack.
  transpilePackages: ["@takeover/api"],
  webpack(cfg) {
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
};

export default config;
