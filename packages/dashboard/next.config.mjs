/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    output: 'standalone',
    transpilePackages: ['@plugport/shared'],
    async rewrites() {
        return [
            {
                source: '/api/proxy/:path*',
                destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'}/:path*`,
            },
        ];
    },
    webpack: (config) => {
        config.resolve.fallback = {
            ...config.resolve.fallback,
            '@react-native-async-storage/async-storage': false,
        };
        // viem's `ox` dependency uses a dynamic require() in its tempo/chain
        // support code that webpack can't statically analyze. Harmless —
        // the module isn't reached at runtime for our supported chains.
        config.ignoreWarnings = [
            ...(config.ignoreWarnings || []),
            { module: /node_modules[\\/]ox[\\/]/, message: /Critical dependency: the request of a dependency is an expression/ },
        ];
        return config;
    },
};

export default nextConfig;
