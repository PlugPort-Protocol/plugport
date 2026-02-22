/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    transpilePackages: ['@plugport/shared'],
    async rewrites() {
        return [
            {
                source: '/api/proxy/:path*',
                destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'}/:path*`,
            },
        ];
    },
};

export default nextConfig;
