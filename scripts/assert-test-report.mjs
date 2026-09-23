#!/usr/bin/env node
import fs from 'node:fs'
import { assertCompleteTests } from './release-checks-lib.mjs'
const file = process.argv[2]
if (!file) throw new Error('Expected path to a fresh Vitest JSON report')
console.log('PASS: ' + assertCompleteTests(JSON.parse(fs.readFileSync(file, 'utf8'))) + ' tests; no SKIP/TODO')
