#!/usr/bin/env node
import { main } from "../src/adapters/cli/main.ts"

const code = await main(process.argv.slice(2))
process.exitCode = code
