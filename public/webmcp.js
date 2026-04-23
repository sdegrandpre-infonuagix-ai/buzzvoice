/* ═══════════════════════════════════════════════
   BuzzVoice — WebMCP Compliance Layer
   Registers tools via navigator.modelContext
   with polyfill for browsers without native support
   ═══════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Tool Definitions ───
  const TOOL_DEFINITIONS = [
    {
      name: 'navigate',
      description: 'Navigate to a URL and read its content aloud using text-to-speech. The user can speak a URL or website name.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL or domain name to navigate to (e.g. "wikipedia.org")' },
        },
        required: ['url'],
      },
    },
    {
      name: 'readPageContent',
      description: 'Read the current page content aloud using text-to-speech.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'saveFavorite',
      description: 'Save the current URL as a favorite with one or more keywords for later vocal retrieval.',
      inputSchema: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords to associate with this favorite for later voice retrieval',
          },
        },
        required: ['keywords'],
      },
    },
    {
      name: 'openFavorite',
      description: 'Find and open a saved favorite URL by searching for a keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Keyword to search for in saved favorites' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'listFavorites',
      description: 'List all saved favorite URLs with their associated keywords, and optionally read them aloud.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'deleteFavorite',
      description: 'Delete a saved favorite by keyword match.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Keyword identifying the favorite to delete' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'changeVoice',
      description: 'Change the text-to-speech voice used for reading content.',
      inputSchema: {
        type: 'object',
        properties: {
          voice: {
            type: 'string',
            enum: ['eve', 'ara', 'leo', 'rex', 'sal'],
            description: 'Voice name for TTS output',
          },
        },
        required: ['voice'],
      },
    },
    {
      name: 'stopSpeaking',
      description: 'Stop any currently playing text-to-speech audio.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'clickLink',
      description: 'Navigate to a numbered link from the current page.',
      inputSchema: {
        type: 'object',
        properties: {
          linkNumber: { type: 'number', description: 'The number of the link to follow (1-indexed)' },
        },
        required: ['linkNumber'],
      },
    },
  ];

  // ─── Handler Registry (populated by app.js) ───
  const handlers = {};

  // ─── Public API for app.js to register handlers ───
  window.__webmcp = {
    registerHandler(toolName, fn) {
      handlers[toolName] = fn;
    },
    async invokeHandler(toolName, params) {
      const handler = handlers[toolName];
      if (!handler) throw new Error(`No handler registered for tool: ${toolName}`);
      return await handler(params);
    },
    getTools() {
      return TOOL_DEFINITIONS;
    },
  };

  // ─── Register with navigator.modelContext (native or polyfill) ───
  function registerTools() {
    // Check for native WebMCP support
    if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
      console.log('[WebMCP] Native navigator.modelContext detected — registering tools');
      TOOL_DEFINITIONS.forEach((tool) => {
        navigator.modelContext.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: async (params) => {
            return await window.__webmcp.invokeHandler(tool.name, params);
          },
        });
      });
    } else {
      // Polyfill: expose tools on window for browser extensions / agents
      console.log('[WebMCP] No native support — using polyfill shim');

      window.__webmcp_tools = TOOL_DEFINITIONS.map((tool) => ({
        ...tool,
        invoke: async (params) => {
          return await window.__webmcp.invokeHandler(tool.name, params);
        },
      }));

      // Emit discovery event
      window.dispatchEvent(new CustomEvent('webmcp-tools-registered', {
        detail: {
          tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      }));
    }
  }

  // Register on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerTools);
  } else {
    registerTools();
  }
})();
