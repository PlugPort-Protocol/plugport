import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
    docsSidebar: [
        {
            type: 'doc',
            id: 'getting-started',
            label: 'Getting Started',
        },
        {
            type: 'doc',
            id: 'migration-guide',
            label: 'Migration Guide',
        },
        {
            type: 'doc',
            id: 'architecture',
            label: 'Architecture',
        },
        {
            type: 'doc',
            id: 'monaddb-integration',
            label: 'MonadDb Integration',
        },
        {
            type: 'category',
            label: 'Protocols',
            collapsed: false,
            link: {
                type: 'generated-index',
                title: 'Protocol Guides',
                description: 'Connect via MongoDB, PostgreSQL, MySQL, Redis, or HTTP REST.',
                slug: '/category/protocols',
            },
            items: [
                'protocols/protocols',
                'advanced/joins',
            ],
        },
        {
            type: 'category',
            label: 'Smart Contracts',
            collapsed: true,
            link: {
                type: 'generated-index',
                title: 'Smart Contracts',
                description: 'On-chain components: PlugPortStore, PrivateStore, MessageBroker, and Relational.',
                slug: '/category/smart-contracts',
            },
            items: [
                'smart-contracts/message-broker',
                'smart-contracts/private-store',
            ],
        },
        {
            type: 'category',
            label: 'SDK Reference',
            collapsed: false,
            link: {
                type: 'generated-index',
                title: 'SDK Reference',
                description: 'PlugPort SDKs for Node.js, Python, Go, and CLI.',
                slug: '/category/sdk-reference',
            },
            items: [
                'sdks/nodejs',
                'sdks/python',
                'sdks/go',
                'sdks/cli',
            ],
        },
        {
            type: 'category',
            label: 'API Reference',
            collapsed: false,
            items: [
                'api-reference/http-api',
                'api-reference/wire-protocol',
                'api-reference/query-operators',
            ],
        },
        {
            type: 'category',
            label: 'Guides',
            items: [
                'guides/deployment',
                'guides/docker',
                'guides/kubernetes',
                'guides/vercel',
                'guides/monitoring',
                'guides/configuration',
            ],
        },
        {
            type: 'doc',
            id: 'faq',
            label: 'FAQ',
        },
    ],
};

export default sidebars;
