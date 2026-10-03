#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
