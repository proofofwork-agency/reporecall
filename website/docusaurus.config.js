// @ts-check
// Docusaurus site config for @proofofwork-agency/reporecall.
// Deployed to GitHub Pages at https://proofofwork-agency.github.io/reporecall/

const { themes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Reporecall',
  tagline:
    'Local codebase memory, intent-routed retrieval, and MCP tools for coding agents',
  favicon: 'img/logo.svg',

  url: 'https://proofofwork-agency.github.io',
  baseUrl: '/reporecall/',

  organizationName: 'proofofwork-agency',
  projectName: 'reporecall',
  trailingSlash: false,

  onBrokenLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: 'docs',
          editUrl:
            'https://github.com/proofofwork-agency/reporecall/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'Reporecall',
        logo: {
          alt: 'Reporecall logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          { to: '/docs/mcp-tools', label: 'MCP Tools', position: 'left' },
          { to: '/docs/cli-reference', label: 'CLI', position: 'left' },
          {
            href: 'https://www.npmjs.com/package/@proofofwork-agency/reporecall',
            label: 'npm',
            position: 'right',
          },
          {
            href: 'https://github.com/proofofwork-agency/reporecall',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Installation', to: '/docs/installation' },
              { label: 'MCP Tools', to: '/docs/mcp-tools' },
              { label: 'CLI Reference', to: '/docs/cli-reference' },
            ],
          },
          {
            title: 'Project',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/proofofwork-agency/reporecall',
              },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/@proofofwork-agency/reporecall',
              },
              { label: 'Changelog', to: '/docs/changelog' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} ProofOfWork. Built with Docusaurus.`,
      },
      prism: {
        theme: themes.github,
        darkTheme: themes.dracula,
        additionalLanguages: ['bash', 'json'],
      },
    }),
};

module.exports = config;
