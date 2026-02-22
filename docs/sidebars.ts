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
            label: 'SDK Reference',
            collapsed: false,
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
