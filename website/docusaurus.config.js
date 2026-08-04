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

  markdown: {
    mermaid: true,
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/docs',
        language: 'en',
        hashed: 'filename',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchBarShortcut: true,
        searchBarShortcutHint: true,
        searchBarShortcutKeymap: 'mod+k',
        searchBarPosition: 'right',
      },
    ],
  ],

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
      // PNG, not the SVG source: X, Slack, LinkedIn and Facebook all ignore
      // SVG og:images, so an SVG card renders as no card at all. The PNG is
      // rasterized from reporecall-social-card.svg at 1200x630 — keep both in
      // sync if the card changes.
      image: 'img/reporecall-social-card.png',
      mermaid: {
        theme: {
          light: 'neutral',
          dark: 'dark',
        },
        options: {
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          flowchart: {
            curve: 'basis',
            htmlLabels: true,
          },
        },
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
