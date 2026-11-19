'use strict';

// Regenerates pack-profiles/schema.json from the zod schema. Run after editing
// src/services/packProfiles/schema.js (a test fails when the two disagree).

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { profile } = require('../src/services/packProfiles/schema');

const out = path.join(__dirname, '..', 'pack-profiles', 'schema.json');
fs.writeFileSync(out, `${JSON.stringify(z.toJSONSchema(profile), null, 2)}\n`);
console.log(`Wrote ${out}`);
