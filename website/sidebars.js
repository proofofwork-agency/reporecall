// @ts-check
// Sidebar for the Reporecall docs. Doc IDs match the files in website/docs/.

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: ['intro', 'installation'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: ['cli-reference', 'mcp-tools', 'configuration'],
    },
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: ['architecture', 'memory', 'lens'],
    },
    {
      type: 'category',
      label: 'Positioning & Analysis',
      collapsed: true,
      items: ['competitive-positioning'],
    },
    'changelog',
  ],
};

module.exports = sidebars;
