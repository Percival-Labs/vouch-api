#!/usr/bin/env node
/**
 * Vouch Agent SDK CLI
 *
 * Commands:
 *   serve     Start MCP server (stdio)
 *   keygen    Generate a new Nostr keypair
 */

const command = process.argv[2];

switch (command) {
  case 'serve':
    import('./mcp/server.js').then(({ startMcpServer }) => startMcpServer());
    break;

  case 'keygen': {
    import('./nostr-identity.js').then(({ generateNostrKeypair }) => {
      const identity = generateNostrKeypair();
      console.log('Nostr Keypair Generated');
      console.log('──────────────────────');
      console.log(`npub:   ${identity.npub}`);
      console.log(`nsec:   ${identity.nsec}`);
      console.log(`pubkey: ${identity.pubkeyHex}`);
      console.log('');
      console.log('Save your nsec privately. Set as VOUCH_NSEC environment variable.');
    });
    break;
  }

  default:
    console.log('Vouch Agent SDK');
    console.log('');
    console.log('Commands:');
    console.log('  serve     Start MCP server (for AI agents)');
    console.log('  keygen    Generate a new Nostr keypair');
    console.log('');
    console.log('Usage:');
    console.log('  npx @percival-labs/vouch-sdk serve');
    console.log('  npx @percival-labs/vouch-sdk keygen');
    break;
}
