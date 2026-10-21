#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('node_22_required');
  process.exitCode = 2;
} else {
  const { main } = await import('../dist/cli.mjs');
  process.exitCode = await main(process.argv.slice(2));
}
