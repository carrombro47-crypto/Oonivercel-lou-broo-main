/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // lean, self-contained build for Docker (Render deploy)
};

export default nextConfig;
