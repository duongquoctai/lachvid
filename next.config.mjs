/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "trycloudflare.com",
    "*.localtunnel.me",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.pinggy.link",
    "localhost:3000",
    "localhost:3005",
  ],
  experimental: {
    proxyClientMaxBodySize: "500mb",
    serverActions: {
      allowedOrigins: [
        "*.trycloudflare.com",
        "trycloudflare.com",
        "*.localtunnel.me",
        "*.ngrok-free.app",
        "*.ngrok.app",
        "*.pinggy.link",
      ],
      bodySizeLimit: "500mb",
    },
  },
};

export default nextConfig;
