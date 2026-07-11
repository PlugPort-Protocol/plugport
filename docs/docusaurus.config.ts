import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
    title: 'PlugPort',
    tagline: 'Web3 protocol port for every database - Apps to dApps in seconds!',
    favicon: 'img/favicon.ico',

    // GitHub Pages deployment config
    url: 'https://wiki.plugport.wtf',
    baseUrl: '/',
    organizationName: 'PlugPort-Protocol',
    projectName: 'plugport',
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
                    editUrl: 'https://github.com/PlugPort-Protocol/plugport/tree/main/docs/',
                    routeBasePath: '/',
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
                    to: 'category/sdk-reference',
                    label: 'SDKs',
                    position: 'left',
                },
                {
                    to: 'api-reference/http-api',
                    label: 'API',
                    position: 'left',
                },
                {
                    href: 'https://github.com/PlugPort-Protocol/plugport',
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
                        { label: 'Getting Started', to: '/' },
                        { label: 'Migration Guide', to: 'migration-guide' },
                        { label: 'Architecture', to: 'architecture' },
                    ],
                },
                {
                    title: 'SDKs',
                    items: [
                        { label: 'Node.js', to: 'sdks/nodejs' },
                        { label: 'Python', to: 'sdks/python' },
                        { label: 'Go', to: 'sdks/go' },
                    ],
                },
                {
                    title: 'Community',
                    items: [
                        { label: 'GitHub', href: 'https://github.com/PlugPort-Protocol/plugport' },
                        { label: 'X (Twitter)', href: 'https://x.com/gPlugPort' },
                        { label: 'Monad', href: 'https://monad.xyz' },
                    ],
                },
            ],
            copyright: `Copyright ${new Date().getFullYear()} PlugPort. Built on Monad with ❤️.`,
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
