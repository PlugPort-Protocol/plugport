import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
    title: 'PlugPort',
    tagline: 'MongoDB-Compatible Document Store on MonadDb',
    favicon: 'img/favicon.ico',

    // GitHub Pages deployment config
    url: 'https://plugport.github.io',
    baseUrl: '/plugport/',
    organizationName: 'plugport',
    projectName: 'plugport',
    deploymentBranch: 'gh-pages',
    trailingSlash: false,

    onBrokenLinks: 'throw',
    onBrokenMarkdownLinks: 'warn',

    i18n: {
        defaultLocale: 'en',
        locales: ['en'],
    },

    presets: [
        [
            'classic',
            {
                docs: {
                    sidebarPath: './sidebars.ts',
                    editUrl: 'https://github.com/plugport/plugport/tree/main/docs/',
                    routeBasePath: 'docs',
                },
                blog: false,
                theme: {
                    customCss: './src/css/custom.css',
                },
            } satisfies Preset.Options,
        ],
    ],

    themeConfig: {
        image: 'img/plugport-social.png',
        navbar: {
            title: 'PlugPort',
            logo: {
                alt: 'PlugPort Logo',
                src: 'img/logo.png',
            },
            items: [
                {
                    type: 'docSidebar',
                    sidebarId: 'docsSidebar',
                    position: 'left',
                    label: 'Docs',
                },
                {
                    to: '/docs/category/sdk-reference',
                    label: 'SDKs',
                    position: 'left',
                },
                {
                    to: '/docs/api-reference/http-api',
                    label: 'API',
                    position: 'left',
                },
                {
                    href: 'https://github.com/plugport/plugport',
                    label: 'GitHub',
                    position: 'right',
                },
            ],
        },
        footer: {
            style: 'dark',
            links: [
                {
                    title: 'Documentation',
                    items: [
                        { label: 'Getting Started', to: '/docs/getting-started' },
                        { label: 'Migration Guide', to: '/docs/migration-guide' },
                        { label: 'Architecture', to: '/docs/architecture' },
                    ],
                },
                {
                    title: 'SDKs',
                    items: [
                        { label: 'Node.js', to: '/docs/sdks/nodejs' },
                        { label: 'Python', to: '/docs/sdks/python' },
                        { label: 'Go', to: '/docs/sdks/go' },
                    ],
                },
                {
                    title: 'Community',
                    items: [
                        { label: 'GitHub', href: 'https://github.com/plugport/plugport' },
                        { label: 'Monad', href: 'https://monad.xyz' },
                    ],
                },
            ],
            copyright: `Copyright ${new Date().getFullYear()} PlugPort. Built for the Monad Ecosystem.`,
        },
        prism: {
            theme: prismThemes.github,
            darkTheme: prismThemes.dracula,
            additionalLanguages: ['bash', 'python', 'go', 'json', 'yaml', 'diff', 'toml'],
        },
        colorMode: {
            defaultMode: 'dark',
            disableSwitch: false,
            respectPrefersColorScheme: true,
        },
        algolia: undefined,
    } satisfies Preset.ThemeConfig,
};

export default config;
