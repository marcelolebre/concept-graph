#!/usr/bin/env node
// Minimal build: produces dist/concept-graph.esm.js and dist/concept-graph.umd.js from src/concept-graph.js
// No deps, no bundler. Just text transformation.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../src/concept-graph.js');
const DIST = path.join(__dirname, '../dist');
fs.mkdirSync(DIST, { recursive: true });

const src = fs.readFileSync(SRC, 'utf8');

// ESM build: copy as-is (already an ES module)
fs.writeFileSync(path.join(DIST, 'concept-graph.esm.js'), src);

// UMD build: strip export statements, wrap in UMD factory
const umdBody = src
  .replace(/^export\s+class\s+ConceptGraph/m, 'class ConceptGraph')
  .replace(/^export\s+default\s+ConceptGraph;?\s*$/m, '');

const umd = `(function (global, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    global.ConceptGraph = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
${umdBody}
  return ConceptGraph;
}));
`;
fs.writeFileSync(path.join(DIST, 'concept-graph.umd.js'), umd);

console.log('built dist/concept-graph.esm.js');
console.log('built dist/concept-graph.umd.js');
