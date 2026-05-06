#!/usr/bin/env node
// Tiny shim — keeps `bin/` resolvable directly from `npm install -g`
// without contributors having to remember the `dist/` path. Forwards
// argv straight into the compiled CLI module.
"use strict";
require("../dist/cli.js").main(process.argv.slice(2));
