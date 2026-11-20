#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PleskOfflineTransferError,
  previewPleskOfflineTransfer,
} from '../apps/api/src/plesk-offline-transfer.js';

const flags = new Map([
  ['--bundle-dir', 'bundleDirectory'],
  ['--staging-dir', 'stagingDirectory'],
  ['--server-id', 'serverId'],
  ['--source-domain', 'sourceDomain'],
  ['--source-database', 'sourceDatabase'],
  ['--target-domain', 'targetDomain'],
  ['--target-database', 'targetDatabase'],
  ['--expect', 'expectedDigest'],
]);

const usage = `Usage: node scripts/plesk-transfer.mjs --bundle-dir <path> --staging-dir <path>
       --server-id <target UUID> --source-domain <name> --source-database <name>
       --target-domain <name> --target-database <name> [--expect <SHA-256>]

Use absolute, real paths to locally owned directories. The bundle must contain
plesk.json (one PHP site with explicit version and one MySQL/MariaDB database),
site/ (the tree containing the relative document root) and database.sql.
The staging directory must already exist and be empty. Nothing is written.
Use the digest in --expect for a second run to verify the same inputs and target.
SQL content is hashed, not parsed or executed.`;

function parseArguments(argv) {
  if (argv.length % 2 !== 0) throw new Error(usage);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = flags.get(argv[index]);
    const value = argv[index + 1];
    if (!field || !value || Object.hasOwn(options, field)) throw new Error(usage);
    options[field] = value;
  }
  if ([...flags.values()].some((field) => field !== 'expectedDigest' && !Object.hasOwn(options, field))) {
    throw new Error(usage);
  }
  return options;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(usage);
    return;
  }
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    const preview = await previewPleskOfflineTransfer(options);
    console.log(JSON.stringify(preview, null, 2));
  } catch (error) {
    if (error instanceof PleskOfflineTransferError) console.error(`${error.code}: ${error.message}`);
    else console.error('Could not prepare the offline transfer');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
