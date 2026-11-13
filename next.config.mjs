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
    "*.up.railway.app",
    "*.railway.app",
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
        "*.up.railway.app",
        "*.railway.app",
      ],
      bodySizeLimit: "500mb",
    },
  },
};

export default nextConfig;
